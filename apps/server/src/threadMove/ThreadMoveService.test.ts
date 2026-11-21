import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";
import * as WorkspaceTransfer from "./WorkspaceTransfer.ts";

const sourceId = ThreadId.make("source");
const destinationId = EnvironmentId.make("destination");
const input = {
  threadId: sourceId,
  destinationEnvironmentId: destinationId,
  resumeAtReset: false,
};

const makeHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const state = yield* Ref.make(idleThreadProjection(liveThreadShell(sourceId)));
  const prepareFails = yield* Ref.make(false);
  const activationFails = yield* Ref.make(false);
  const captures = yield* Ref.make(0);
  const deletedProjects = yield* Ref.make<ReadonlyArray<string>>([]);
  const requests = yield* Ref.make<ReadonlyArray<string>>([]);
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const now = DateTime.makeUnsafe(0);
  const project = (id: ProjectId) => ({
    id,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: DateTime.formatIso(now),
    updatedAt: DateTime.formatIso(now),
    deletedAt: null,
  });
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const action = request.url.split("/").at(-1)!;
      yield* Ref.update(requests, (current) => [...current, action]);
      if (action === "activate") {
        assert.equal((yield* Ref.get(state)).thread.move?.phase, "committed");
      }
      const failed =
        (action === "prepare" && (yield* Ref.get(prepareFails))) ||
        (action === "activate" && (yield* Ref.get(activationFails)));
      const move = (yield* Ref.get(state)).thread.move;
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            environmentId: destinationId,
            threadId: move?.threadId ?? "discarded",
            label: "Destination",
            link: `t3-thread://v2/${destinationId}/${move?.threadId}`,
          }),
          { status: failed ? 503 : 200, headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
  const layer = ThreadMoveService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Ref.get(state),
          getThread: () => Ref.get(state).pipe(Effect.map((current) => current.thread)),
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.gen(function* () {
              for (const event of events) {
                if (event.type === "thread.metadata-updated") {
                  yield* Ref.update(state, (current) => ({ ...current, thread: event.payload }));
                }
              }
              return [];
            }),
        }),
        ThreadCommandExecutor.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              yield* Ref.update(dispatched, (current) => [...current, command]);
              if (command.type === "thread.stop")
                yield* Ref.update(state, (current) => ({
                  ...current,
                  runs: current.runs.map((run) => ({ ...run, status: "interrupted" as const })),
                }));
              return { sequence: 0, storedEvents: [] };
            }),
          waitForThread: () => Effect.succeed({ threadId: sourceId, run: null, timedOut: false }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          delete: ({ projectId }) =>
            Ref.update(deletedProjects, (current) => [...current, projectId]).pipe(
              Effect.as(project(projectId)),
            ),
          getById: () =>
            Ref.get(state).pipe(
              Effect.map((current) => Option.some(project(current.thread.projectId))),
            ),
        }),
        Layer.mock(WorkspaceTransfer.WorkspaceTransfer)({
          capture: ({ staging }) =>
            Effect.gen(function* () {
              yield* Ref.update(captures, (count) => count + 1);
              yield* fs.writeFileString(path.join(staging, "workspace.bundle"), "bundle");
              yield* fs.writeFileString(path.join(staging, "staged.patch"), "");
              return {
                head: "a".repeat(40),
                checkpoint: "b".repeat(40),
                branch: "main",
                prefix: "",
                remotes: [],
                upstream: null,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceTransfer.WorkspaceTransferError({ operation: "capture", cause }),
              ),
            ),
        }),
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(true),
          resolve: () =>
            Effect.succeed({
              url: "http://destination.test",
              token: "test-token",
              link: {
                environmentId: destinationId,
                label: "Destination",
                urls: ["http://destination.test"],
                access: "full-access",
                linkedAt: now,
                expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
                lastReachedAt: null,
                lastError: null,
              },
              capabilities: { repositoryIdentity: true },
            }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("source")),
          getDescriptor: Effect.succeed(descriptorOf("source", "Source")),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
        Layer.mock(HostResources.HostResources)({}),
        Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        ServerSettings.layerTest(),
        Layer.succeed(HttpClient.HttpClient, client),
      ),
    ),
  );
  const context = yield* Layer.build(layer);
  return {
    moves: Context.get(context, ThreadMoveService.ThreadMoveService),
    state,
    prepareFails,
    activationFails,
    captures,
    requests,
    dispatched,
    deletedProjects,
  };
});

const runningTurn: OrchestrationV2Run = {
  id: RunId.make("run-running"),
  threadId: sourceId,
  ordinal: 1,
  providerInstanceId: idleThreadProjection(liveThreadShell(sourceId)).thread.providerInstanceId,
  modelSelection: idleThreadProjection(liveThreadShell(sourceId)).thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message-running"),
  rootNodeId: NodeId.make("node-running"),
  activeAttemptId: null,
  status: "running",
  requestedAt: DateTime.makeUnsafe(0),
  startedAt: DateTime.makeUnsafe(0),
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "thread-move-" }),
  NodeCrypto.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("a running turn stops for a move, and continues here when the move is cancelled", () =>
  Effect.gen(function* () {
    const { moves, state, prepareFails, requests, dispatched } = yield* makeHarness;
    yield* Ref.update(state, (current) => ({ ...current, runs: [runningTurn] }));
    yield* Ref.set(prepareFails, true);
    yield* moves.move(input).pipe(Effect.flip);
    const frozen = (yield* Ref.get(state)).thread;
    assert.equal(frozen.move?.phase, "preparing");
    assert.isTrue(frozen.move?.resume);
    assert.isNull(frozen.archivedAt);
    assert.deepEqual(
      (yield* Ref.get(dispatched)).map((command) => command.type),
      ["thread.stop"],
    );
    yield* moves.cancel(sourceId);
    const restored = (yield* Ref.get(state)).thread;
    assert.isNull(restored.move);
    assert.isNull(restored.archivedAt);
    assert.equal((yield* Ref.get(requests)).at(-1), "discard");
    assert.deepEqual(
      (yield* Ref.get(dispatched)).map((command) => command.type),
      ["thread.stop", "message.dispatch"],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("an ambiguous activation keeps the source committed and retries the same handoff", () =>
  Effect.gen(function* () {
    const { moves, state, activationFails, captures, requests, dispatched } = yield* makeHarness;
    yield* Ref.set(activationFails, true);
    assert.equal((yield* moves.move(input).pipe(Effect.flip)).reason, "committed");
    const frozen = (yield* Ref.get(state)).thread;
    assert.equal(frozen.move?.phase, "committed");
    assert.isNull(frozen.archivedAt);
    assert.equal((yield* moves.cancel(sourceId).pipe(Effect.flip)).reason, "committed");
    yield* Ref.set(activationFails, false);
    const moved = yield* moves.move(input);
    assert.equal(moved.threadId, frozen.move?.threadId);
    assert.equal((yield* Ref.get(state)).thread.move?.phase, "complete");
    assert.isNotNull((yield* Ref.get(state)).thread.archivedAt);
    assert.equal(yield* Ref.get(captures), 1);
    const sent = yield* Ref.get(requests);
    assert.equal(sent.filter((action) => action === "activate").length, 2);
    assert.equal(sent.filter((action) => action === "prepare").length, 1);
    assert.deepEqual(yield* moves.move(input), moved);
    assert.deepEqual(yield* Ref.get(requests), sent);
    assert.isUndefined(frozen.move?.resume);
    assert.deepEqual(yield* Ref.get(dispatched), []);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("discarding a prepared destination also removes its project", () =>
  Effect.gen(function* () {
    const { moves, deletedProjects } = yield* makeHarness;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const id = "00000000-0000-4000-8000-000000000001";
    const folder = path.join(config.stateDir, "thread-moves", id);
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(
      path.join(folder, "move.json"),
      JSON.stringify({
        owner: "peer",
        ready: true,
        header: {
          id,
          sourceEnvironmentId: "source",
          sourceLabel: "Source",
          sourceThreadId: sourceId,
          title: "Thread",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          resumeAtReset: false,
        },
      }),
    );
    yield* moves.discard("peer", id);
    assert.deepEqual(yield* Ref.get(deletedProjects), [`moved-${id}`]);
    assert.isFalse(yield* fs.exists(folder));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
