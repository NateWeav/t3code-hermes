import { assert, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe } from "vite-plus/test";

import * as HermesSpareRuntime from "./HermesSpareRuntime.ts";

interface Launched {
  readonly runtimeMode: RuntimeMode;
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly bindings: Array<AcpSessionRuntime.AcpSessionRuntimeBinding>;
  readonly stopped: Deferred.Deferred<void>;
}

const binding = (cwd: string): AcpSessionRuntime.AcpSessionRuntimeBinding => ({
  cwd,
  clientInfo: { name: "t3-code", version: "0.0.0" },
});

/** A pool whose launches arrive on `launches`; `exited` makes every spare refuse its binding. */
const makePool = (options: { readonly exited?: boolean } = {}) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<Launched>();
    const poolScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(poolScope, Exit.void));
    const pool = yield* HermesSpareRuntime.make({
      launch: (runtimeMode) =>
        Effect.gen(function* () {
          const stopped = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
          const bindings: Array<AcpSessionRuntime.AcpSessionRuntimeBinding> = [];
          const runtime = {
            bind: (next: AcpSessionRuntime.AcpSessionRuntimeBinding) =>
              options.exited === true
                ? Effect.fail(new EffectAcpErrors.AcpProcessExitedError({ code: 1 }))
                : Effect.sync(() => {
                    bindings.push(next);
                  }),
          } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
          yield* Queue.offer(launches, { runtimeMode, runtime, bindings, stopped });
          return runtime;
        }),
      initialRuntimeMode: "full-access",
      idleTimeout: "30 minutes",
    }).pipe(Scope.provide(poolScope));
    return { pool, launches, poolScope };
  });

describe("HermesSpareRuntime", () => {
  it.effect("hands its spare to the next session of that mode and boots another", () =>
    Effect.gen(function* () {
      const { pool, launches, poolScope } = yield* makePool();
      const first = yield* Queue.take(launches);
      const session = yield* Scope.make();

      const adopted = yield* pool
        .adopt("full-access", binding("/work/thread"))
        .pipe(Scope.provide(session));

      assert.strictEqual(adopted, first.runtime);
      assert.deepStrictEqual(first.bindings, [binding("/work/thread")]);
      const next = yield* Queue.take(launches);
      assert.strictEqual(next.runtimeMode, "full-access");
      yield* Scope.close(session, Exit.void);
      assert.isTrue(yield* Deferred.isDone(first.stopped));
      assert.isFalse(yield* Deferred.isDone(next.stopped));
      yield* Scope.close(poolScope, Exit.void);
      assert.isTrue(yield* Deferred.isDone(next.stopped));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a spare of one mode from a session of another and boots that mode next", () =>
    Effect.gen(function* () {
      const { pool, launches } = yield* makePool();
      const first = yield* Queue.take(launches);

      const adopted = yield* pool
        .adopt("approval-required", binding("/work/thread"))
        .pipe(Effect.scoped);

      assert.isUndefined(adopted);
      assert.deepStrictEqual(first.bindings, []);
      const next = yield* Queue.take(launches);
      assert.strictEqual(next.runtimeMode, "approval-required");
      assert.isTrue(yield* Deferred.isDone(first.stopped));
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a spare that exited while idle", () =>
    Effect.gen(function* () {
      const { pool, launches } = yield* makePool({ exited: true });
      const first = yield* Queue.take(launches);

      const adopted = yield* pool.adopt("full-access", binding("/work/thread")).pipe(Effect.scoped);

      assert.isUndefined(adopted);
      assert.isTrue(yield* Deferred.isDone(first.stopped));
      assert.strictEqual((yield* Queue.take(launches)).runtimeMode, "full-access");
    }).pipe(Effect.scoped),
  );

  it.effect("stops a spare no session adopts within the idle timeout", () =>
    Effect.gen(function* () {
      const { pool, launches } = yield* makePool();
      const first = yield* Queue.take(launches);

      yield* TestClock.adjust("30 minutes");
      yield* Deferred.await(first.stopped);

      assert.isUndefined(
        yield* pool.adopt("full-access", binding("/work/thread")).pipe(Effect.scoped),
      );
      assert.strictEqual((yield* Queue.take(launches)).runtimeMode, "full-access");
    }).pipe(Effect.scoped),
  );
});
