// @effect-diagnostics nodeBuiltinImport:off - Update leases coordinate Node server processes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
    /** Runs if the command is interrupted after it claimed `targetKey`, queued or running. */
    readonly onInterrupt?: Effect.Effect<void, never, R>;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
}

const updateLocks = new Map<string, Semaphore.Semaphore>();

/**
 * The process-wide lock for one update lock key. Shared across coordinators
 * (each WebSocket connection builds its own) and with anything else that
 * mutates the same installation, such as the Hermes Patches tab.
 */
export const providerUpdateLock = (lockKey: string) => {
  let lock = updateLocks.get(lockKey);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    updateLocks.set(lockKey, lock);
  }
  return lock;
};

class MachineLockError extends Schema.TaggedError<MachineLockError>()("MachineLockError", {
  held: Schema.Boolean,
  cause: Schema.Defect(),
}) {}

const lockDirectory = () => NodePath.join(NodeOS.tmpdir(), "t3code-provider-updates");

/** @internal */
export const machineLockFile = (lockKey: string) =>
  NodePath.join(
    lockDirectory(),
    NodeCrypto.createHash("sha256").update(lockKey).digest("hex").slice(0, 32),
  );

// Other T3 servers on this machine can run the same installation's updater; one replacing its own
// files makes the other's spawn or capability check fail. Without a usable lock directory, run anyway.
const withMachineLock = <A, E, R>(
  lockKey: string,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const directory = lockDirectory();
  const file = machineLockFile(lockKey);
  const acquire = Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(directory, { recursive: true });
        return await lock(file, {
          realpath: false,
          stale: 60_000,
          update: 10_000,
          onCompromised: () => {},
        });
      },
      catch: (cause) =>
        new MachineLockError({
          held: (cause as { code?: unknown } | null)?.code === "ELOCKED",
          cause,
        }),
    }),
    // A compromised lease rejects on release; the update has already finished by then.
    (release) => Effect.promise(() => release().catch(() => undefined)),
  ).pipe(
    Effect.retry({ while: (error) => error.held, schedule: Schedule.spaced("1 second") }),
    Effect.catch((error) =>
      Effect.logWarning("Could not lock provider update across servers", {
        lockKey,
        cause: String(error.cause),
      }),
    ),
  );
  return Effect.scoped(acquire.pipe(Effect.andThen(run)));
};

export const makeProviderMaintenanceCommandCoordinator = Effect.fn(
  "makeProviderMaintenanceCommandCoordinator",
)(function* <E>(input: { readonly makeAlreadyRunningError: (targetKey: string) => E }) {
  const runningTargetsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const acquireTarget = Effect.fn("acquireTarget")(function* (targetKey: string) {
    return yield* Ref.modify(runningTargetsRef, (runningTargets) => {
      if (runningTargets.has(targetKey)) {
        return [false, runningTargets] as const;
      }
      const next = new Set(runningTargets);
      next.add(targetKey);
      return [true, next] as const;
    });
  });

  const releaseTarget = (targetKey: string) =>
    Ref.update(runningTargetsRef, (runningTargets) => {
      const next = new Set(runningTargets);
      next.delete(targetKey);
      return next;
    });

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] =
    Effect.fn("providerMaintenanceCommandCoordinator.withCommandLock")(function* ({
      targetKey,
      lockKey,
      onQueued,
      onInterrupt,
      run,
    }) {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      // The process-wide lock, not one per coordinator: every connection
      // builds its own coordinator, and an update must still exclude the rest.
      const locked = (onQueued ?? Effect.void).pipe(
        Effect.andThen(providerUpdateLock(lockKey).withPermits(1)(withMachineLock(lockKey, run))),
      );
      return yield* (
        onInterrupt ? locked.pipe(Effect.onInterrupt(() => onInterrupt)) : locked
      ).pipe(Effect.ensuring(releaseTarget(targetKey)));
    });

  return {
    withCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
