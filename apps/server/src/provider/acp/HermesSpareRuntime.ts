/**
 * Keeps one `hermes acp` booted ahead of the next Hermes session, so opening a thread skips the
 * viewer's Python startup. The process gets nothing a thread owns before its first request: the
 * session that adopts it binds its own cwd, MCP servers and callbacks. Spares are kept per
 * runtime mode, the one launch input that differs between sessions (`HERMES_YOLO_MODE`).
 */
import type { RuntimeMode } from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as EffectAcpErrors from "effect-acp/errors";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

export interface HermesSpareRuntimes {
  /**
   * The spare for `runtimeMode`, bound to `binding` and closed with the caller's scope, or
   * undefined when none is ready. Either way a spare for `runtimeMode` boots next.
   */
  readonly adopt: (
    runtimeMode: RuntimeMode,
    binding: AcpSessionRuntime.AcpSessionRuntimeBinding,
  ) => Effect.Effect<Runtime | undefined, never, Scope.Scope>;
}

interface Spare {
  readonly runtimeMode: RuntimeMode;
  readonly runtime: Runtime;
  readonly scope: Scope.Closeable;
}

export const make = Effect.fn("HermesSpareRuntime.make")(function* (options: {
  /** Spawns `hermes acp` for a runtime mode in the given scope, sending it nothing. */
  readonly launch: (
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError, Scope.Scope>;
  readonly initialRuntimeMode: RuntimeMode;
  /** An idle viewer holds about 100 MB, so a spare no session adopts in this long is stopped. */
  readonly idleTimeout: Duration.Input;
}) {
  const poolScope = yield* Effect.scope;
  // Guards `spare`, `expiry` and `closed`.
  const permit = yield* Semaphore.make(1);
  let spare: Spare | undefined;
  let expiry: Fiber.Fiber<void> | undefined;
  let closed = false;

  const detach = Effect.suspend(() => {
    const current = spare;
    const timer = expiry;
    spare = undefined;
    expiry = undefined;
    return (timer === undefined ? Effect.void : Fiber.interrupt(timer)).pipe(Effect.as(current));
  });
  const stop = (current: Spare | undefined) =>
    current === undefined ? Effect.void : Scope.close(current.scope, Exit.void);

  const replenish = Effect.fn("HermesSpareRuntime.replenish")(function* (runtimeMode: RuntimeMode) {
    yield* permit.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed || spare?.runtimeMode === runtimeMode) return;
          yield* stop(yield* detach);
          const scope = yield* Scope.make();
          const launched = yield* Effect.exit(
            restore(options.launch(runtimeMode).pipe(Scope.provide(scope))),
          );
          if (Exit.isFailure(launched)) {
            yield* Scope.close(scope, launched);
            yield* Effect.logDebug("Hermes spare runtime did not launch.", {
              cause: launched.cause,
            });
            return;
          }
          spare = { runtimeMode, runtime: launched.value, scope };
          expiry = yield* Effect.sleep(options.idleTimeout).pipe(
            Effect.andThen(
              permit.withPermit(
                Effect.suspend(() => {
                  // This fiber is the timer: `detach` must not interrupt it.
                  expiry = undefined;
                  return detach.pipe(Effect.flatMap(stop));
                }),
              ),
            ),
            Effect.forkIn(poolScope, { startImmediately: true }),
          );
        }),
      ),
    );
  });

  yield* Effect.addFinalizer(() =>
    permit.withPermit(
      Effect.suspend(() => {
        closed = true;
        return detach.pipe(Effect.flatMap(stop));
      }),
    ),
  );
  yield* replenish(options.initialRuntimeMode).pipe(Effect.forkIn(poolScope));

  const adopt = Effect.fn("HermesSpareRuntime.adopt")(function* (
    runtimeMode: RuntimeMode,
    binding: AcpSessionRuntime.AcpSessionRuntimeBinding,
  ) {
    const adopter = yield* Effect.scope;
    const adopted = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const current = yield* permit.withPermit(
          Effect.suspend(() => (spare?.runtimeMode === runtimeMode ? detach : Effect.undefined)),
        );
        if (current === undefined) return undefined;
        const bound =
          current.runtime.bind === undefined
            ? undefined
            : yield* Effect.exit(current.runtime.bind(binding));
        if (bound === undefined || Exit.isFailure(bound)) {
          // It exited while idle; the session launches its own.
          yield* stop(current);
          return undefined;
        }
        yield* Scope.addFinalizer(adopter, stop(current));
        return current.runtime;
      }),
    );
    yield* replenish(runtimeMode).pipe(Effect.forkIn(poolScope));
    return adopted;
  });

  return { adopt } satisfies HermesSpareRuntimes;
});
