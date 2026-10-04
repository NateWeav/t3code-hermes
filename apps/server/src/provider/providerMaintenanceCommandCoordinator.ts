import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
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

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] = ({
    targetKey,
    lockKey,
    onQueued,
    run,
  }) =>
    Effect.gen(function* () {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      return yield* Effect.gen(function* () {
        const lock = providerUpdateLock(lockKey);
        if (onQueued) {
          yield* onQueued;
        }
        return yield* lock.withPermits(1)(run);
      }).pipe(Effect.ensuring(releaseTarget(targetKey)));
    });

  return {
    withCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
