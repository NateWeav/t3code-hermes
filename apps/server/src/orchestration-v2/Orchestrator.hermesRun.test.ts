// Fork: Hermes background runs mirrored as threads carry `hermesRun` through V2.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadHermesRun,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-hermes-run-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by these tests"),
  } as ProviderAdapterV2Shape,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfigLayer),
          Layer.provide(PlatformTestLayer),
        ),
      ),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(PlatformTestLayer),
);

const hermesRun = (sessionId: string, live: boolean): ThreadHermesRun => ({
  profile: "upstream-sync",
  sourceKey: "webhook:upstream-sync",
  sourceLabel: "webhook/upstream-sync",
  sessionId,
  latestSessionId: sessionId,
  live,
});

const PROJECT_ID = ProjectId.make("hermes-run-project");

/** Seeds the project row the way a committed `project.created` event folds into it. */
const seedProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${PROJECT_ID}`),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    occurredAt: "2026-09-30T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: PROJECT_ID,
      title: "Hermes runs",
      workspaceRoot: "/tmp/t3-hermes-run-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  }),
);

const createThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`hermes-run:upstream-sync:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(`${name}-create`),
      threadId,
      projectId: PROJECT_ID,
      title: `Run ${name}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    return threadId;
  });

const setRun = (threadId: ThreadId, run: ThreadHermesRun, suffix: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.hermes-run.set",
      commandId: CommandId.make(`${threadId}:${suffix}`),
      threadId,
      hermesRun: run,
    }),
  );

const reply = (threadId: ThreadId, name: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${name}-reply`),
      threadId,
      messageId: MessageId.make(`${name}-reply`),
      text: "Go ahead.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    }),
  );

it.layer(TestLayer)("hermesRun on orchestration V2 threads", (it) => {
  it.effect("records the run as thread metadata on the thread and its shell", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("metadata");
      const result = yield* setRun(threadId, hermesRun("metadata", true), "live");
      assert.deepStrictEqual(
        result.storedEvents.map((stored) => stored.event.type),
        ["thread.metadata-updated"],
      );
      const { thread } = yield* orchestrator.getThreadProjection(threadId);
      assert.deepStrictEqual(thread.hermesRun, hermesRun("metadata", true));
      // Its run-less transcript reaches the first reply as imported history.
      assert.strictEqual(thread.historyOrigin, "v1_import");
      assert.deepStrictEqual(
        (yield* projections.getThreadShell(threadId))?.hermesRun,
        hermesRun("metadata", true),
      );
      assert.deepStrictEqual(
        (yield* projections.getLiveHermesRunThreads()).map((thread) => thread.id),
        [threadId],
      );

      yield* setRun(threadId, hermesRun("metadata", false), "ended");
      assert.deepStrictEqual(yield* projections.getLiveHermesRunThreads(), []);
      assert.strictEqual((yield* projections.getThreadShell(threadId))?.hermesRun?.live, false);
    }),
  );

  it.effect("holds replies to any thread of a source while one of its runs is live", () =>
    Effect.gen(function* () {
      yield* seedProject;
      const live = yield* createThread("busy-live");
      const finished = yield* createThread("busy-finished");
      yield* setRun(live, hermesRun("busy-live", true), "live");
      yield* setRun(finished, hermesRun("busy-finished", false), "ended");

      const held = yield* Effect.exit(reply(finished, "busy-held"));
      assert.isTrue(Exit.isFailure(held));
      assert.include(String(Exit.isFailure(held) ? held.cause : ""), "Hermes is still running");

      yield* setRun(live, hermesRun("busy-live", false), "ended");
      const sent = yield* Effect.exit(reply(finished, "busy-sent"));
      assert.isTrue(Exit.isSuccess(sent));
    }),
  );
});
