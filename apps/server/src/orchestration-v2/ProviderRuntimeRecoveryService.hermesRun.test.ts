// Fork: a live mirrored Hermes run is not provider work this server can lose.
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadHermesRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";

const hermesRun = (live: boolean): ThreadHermesRun => ({
  profile: "default",
  sourceKey: "cron:nightly",
  sourceLabel: "nightly",
  sessionId: "s1",
  latestSessionId: "s1",
  live,
});

/** Recovers one mirrored thread whose last tool call is still running. */
const recoverMirroredThread = (run: ThreadHermesRun) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("hermes-run:default:s1");
    const now = yield* DateTime.now;
    const committed: OrchestrationV2DomainEvent[] = [];
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () =>
              Effect.succeed({
                thread: {
                  id: threadId,
                  projectId: ProjectId.make("project-1"),
                  providerInstanceId: ProviderInstanceId.make("hermes"),
                  hermesRun: run,
                },
                runtimeRequests: [],
                providerSessions: [],
                providerThreads: [],
                providerTurns: [],
                runs: [],
                attempts: [],
                nodes: [],
                subagents: [],
                messages: [],
                turnItems: [
                  {
                    id: TurnItemId.make(`${threadId}:tool:call-1`),
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "running",
                    title: "terminal: git fetch",
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                    type: "command_execution",
                    input: "git fetch",
                  },
                ],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) =>
              Effect.sync(() => {
                committed.push(...input.events);
                return { cancelledEffectCount: 0 } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            cancelUnsettled: () => Effect.succeed([]),
            signalCancellations: () => Effect.void,
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.recover),
      Effect.provide(layer),
    );
    return committed;
  });

it.effect("leaves a live Hermes run's running tool rows for the run to finish", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* recoverMirroredThread(hermesRun(true)), []);
    // Once the run has ended, a row it left running is cancelled like any other.
    assert.deepStrictEqual(
      (yield* recoverMirroredThread(hermesRun(false))).map((event) =>
        event.type === "turn-item.updated" ? event.payload.status : event.type,
      ),
      ["cancelled"],
    );
  }),
);
