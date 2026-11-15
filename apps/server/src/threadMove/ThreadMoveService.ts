import {
  CommandId,
  EventId,
  HostResourcesSnapshot,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  ThreadMoveError,
  ThreadMoveResult,
  ThreadMoveModels,
  isRuntimeModeAbove,
  type EnvironmentId,
  type ThreadMoveInput,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  readInheritedHandoffItems,
  visibleConversationItems,
} from "../orchestration-v2/ContextHandoffService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as WorkspaceTransfer from "./WorkspaceTransfer.ts";
import { importedMoveEvents, portableItem } from "./portableHistory.ts";
import {
  canAutomaticallyMove,
  hasSpareCapacity,
  isOverloaded,
  isWorkingShell,
  LOAD_SAMPLE_INTERVAL_MS,
  SUSTAINED_LOAD_MS,
} from "./loadBalancing.ts";
import {
  MoveHeader,
  MoveHistory,
  MoveId,
  StoredMove,
  MOVE_ROUTE,
  MAX_FILE_BYTES,
  MAX_HISTORY_BYTES,
  moveThreadId,
} from "./protocol.ts";

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
    readonly moveAutomatically: (
      input: ThreadMoveInput,
    ) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void, ThreadMoveError>;
    readonly catalog: Effect.Effect<ThreadMoveModels>;
    readonly models: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ThreadMoveModels, ThreadMoveError>;
    readonly capacity: Effect.Effect<HostResourcesSnapshot, ThreadMoveError>;
    readonly destinationCapacity: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<HostResourcesSnapshot, ThreadMoveError>;
    readonly begin: (owner: string, header: MoveHeader) => Effect.Effect<void, ThreadMoveError>;
    readonly upload: <E>(
      owner: string,
      id: string,
      name: string,
      body: Stream.Stream<Uint8Array, E>,
    ) => Effect.Effect<void, ThreadMoveError>;
    readonly prepare: (
      owner: string,
      id: string,
    ) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
    readonly activate: (
      owner: string,
      id: string,
    ) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
    readonly discard: (owner: string, id: string) => Effect.Effect<void, ThreadMoveError>;
  }
>()("t3-hermes/threadMove/ThreadMoveService") {}

const storageError = (cause: unknown) => new ThreadMoveError({ reason: "storage", cause });
const isThreadMoveError = Schema.is(ThreadMoveError);
const transferError = (cause: unknown) =>
  isThreadMoveError(cause) ? cause : new ThreadMoveError({ reason: "transfer", cause });
const decodeMoveId = Schema.decodeSync(MoveId);
const encodeHeader = Schema.encodeEffect(Schema.fromJsonString(MoveHeader));
const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(StoredMove)));
const decodeStored = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(StoredMove)),
);
const encodeHistory = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(MoveHistory)));
const decodeHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(MoveHistory)),
);

type SourceRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "runtimeRequests" | "subagents" | "providerThreads"
>;
const SOURCE_RECORDS = ["runs", "runtimeRequests", "subagents", "providerThreads"] as const;
/** Work that Stop ends; a move stops it and continues the thread where it lands. */
const isWorking = (source: SourceRecords) =>
  source.runs.some(ThreadManagement.isActiveRun) ||
  source.runtimeRequests.some((request) => request.status === "pending") ||
  source.subagents.some((task) => ["pending", "running", "waiting"].includes(task.status)) ||
  source.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0);
const moveBlocker = (source: SourceRecords): "unsupported" | "busy" | null => {
  const { thread } = source;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.lineage.relationshipToParent === "subagent" ||
    thread.hermesRun != null
  )
    return "unsupported";
  // Stop holds queued messages, and a watch wakes the thread; neither carries over.
  if (
    source.runs.some((run) => run.status === "queued") ||
    thread.pullRequests?.some((pr) => pr.watch !== undefined)
  )
    return "busy";
  return null;
};
const continueCommand = (
  threadId: ThreadId,
  key: string,
  text: string,
): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(`move-resume:${key}`),
  messageId: MessageId.make(`move-resume:${key}`),
  threadId,
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "agent",
  creationSource: "server",
});

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const operations = yield* KeyedLock.make<string>();
  const projects = yield* ProjectService.ProjectService;
  const management = yield* ThreadManagement.ThreadManagementService;
  const workspaces = yield* WorkspaceTransfer.WorkspaceTransfer;
  const links = yield* PeerLinks.PeerLinks;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const resources = yield* HostResources.HostResources;
  const scheduler = yield* Scheduler.Scheduler;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const here = yield* environment.getEnvironmentId;
  const descriptor = yield* environment.getDescriptor;
  const root = path.join(config.stateDir, "thread-moves");
  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.mapError(storageError));

  const folder = (id: string) => path.join(root, decodeMoveId(id));
  const writeStored = Effect.fn("ThreadMoveService.writeStored")(function* (
    id: string,
    value: StoredMove,
  ) {
    const target = path.join(folder(id), "move.json");
    yield* fs.makeDirectory(folder(id), { recursive: true });
    yield* fs.writeFileString(`${target}.part`, yield* encodeStored(value), { mode: 0o600 });
    yield* fs.rename(`${target}.part`, target);
  }, Effect.mapError(storageError));
  const readStored = Effect.fn("ThreadMoveService.readStored")(function* (
    owner: string,
    id: string,
  ) {
    const stored = yield* fs
      .readFileString(path.join(folder(id), "move.json"))
      .pipe(Effect.flatMap(decodeStored));
    if (stored.owner !== owner) return yield* new ThreadMoveError({ reason: "destination" });
    return stored;
  }, Effect.mapError(transferError));
  const readHistory = Effect.fn("ThreadMoveService.readHistory")(function* (id: string) {
    const file = path.join(folder(id), "history.json");
    if ((yield* fs.stat(file)).size > MAX_HISTORY_BYTES)
      return yield* new ThreadMoveError({ reason: "unsupported" });
    return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeHistory));
  }, Effect.mapError(transferError));
  const publishThread = Effect.fn("ThreadMoveService.publishThread")(function* (
    thread: OrchestrationV2AppThread,
    phase: string,
  ) {
    const now = yield* DateTime.now;
    const suffix = yield* random.uuidV4();
    yield* events.write({
      events: [
        {
          id: EventId.make(`move:${suffix}:${phase}`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: { ...thread, updatedAt: now },
        },
      ],
    });
  }, Effect.mapError(storageError));
  const resultFor = (header: MoveHeader): ThreadMoveResult => ({
    environmentId: here,
    threadId: moveThreadId(header.id),
    label: descriptor.label,
    link: `t3-thread://v2/${encodeURIComponent(here)}/${encodeURIComponent(moveThreadId(header.id))}`,
  });
  const catalog = Effect.gen(function* () {
    const snapshots = yield* Effect.forEach(
      yield* providers.listInstances,
      (instance) => instance.snapshot.getSnapshot,
    );
    return snapshots
      .filter((provider) => provider.enabled && provider.installed)
      .flatMap((provider) =>
        provider.models.map((model) => ({
          selection: { instanceId: provider.instanceId, model: model.slug },
          label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
        })),
      );
  });
  const capacity = resources.read;
  const preflight = Effect.fn("ThreadMoveService.preflight")(function* (header: MoveHeader) {
    if (
      !(yield* links.enabled) ||
      header.sourceEnvironmentId === here ||
      !(yield* catalog).some(
        ({ selection }) =>
          selection.instanceId === header.modelSelection.instanceId &&
          selection.model === header.modelSelection.model,
      )
    )
      return yield* new ThreadMoveError({ reason: "destination" });
    const policy = settings.managedPolicy?.limits?.maxRuntimeMode;
    if (policy !== undefined) {
      if (isRuntimeModeAbove(header.runtimeMode, policy))
        return yield* new ThreadMoveError({ reason: "destination" });
    }
  });

  const begin: ThreadMoveService["Service"]["begin"] = Effect.fn("ThreadMoveService.begin")(
    function (owner, header) {
      return operations.withLock(
        header.id,
        Effect.gen(function* () {
          yield* preflight(header);
          const existing = yield* fs.exists(path.join(folder(header.id), "move.json"));
          if (existing) {
            const stored = yield* readStored(owner, header.id);
            if ((yield* encodeHeader(stored.header)) !== (yield* encodeHeader(header)))
              return yield* new ThreadMoveError({ reason: "destination" });
            return;
          }
          yield* writeStored(header.id, { owner, header, ready: false });
        }).pipe(Effect.mapError(transferError)),
      );
    },
  );

  const upload: ThreadMoveService["Service"]["upload"] = Effect.fn("ThreadMoveService.upload")(
    function (owner, id, name, body) {
      return operations.withLock(
        id,
        Effect.gen(function* () {
          const stored = yield* readStored(owner, id);
          if (stored.ready) return;
          if (!/^(?:workspace\.bundle|staged\.patch|history\.json|attachment-\d+)$/.test(name))
            return yield* new ThreadMoveError({ reason: "unsupported" });
          const maxBytes = name === "history.json" ? MAX_HISTORY_BYTES : MAX_FILE_BYTES;
          let size = 0;
          const target = path.join(folder(id), name);
          yield* body.pipe(
            Stream.mapEffect((chunk) => {
              size += chunk.byteLength;
              return size > maxBytes
                ? Effect.fail(new ThreadMoveError({ reason: "unsupported" }))
                : Effect.succeed(chunk);
            }),
            Stream.run(fs.sink(`${target}.part`, { mode: 0o600 })),
          );
          yield* fs.rename(`${target}.part`, target);
        }).pipe(Effect.mapError(transferError)),
      );
    },
  );

  const prepare: ThreadMoveService["Service"]["prepare"] = Effect.fn("ThreadMoveService.prepare")(
    function (owner, id) {
      return operations.withLock(
        id,
        Effect.gen(function* () {
          const stored = yield* readStored(owner, id);
          if (stored.ready) return resultFor(stored.header);
          yield* preflight(stored.header);
          const threadId = moveThreadId(id);
          const existing = yield* projections.getThreadShell(threadId);
          if (existing !== null) {
            if (existing.move?.id !== id || existing.move.direction !== "incoming")
              return yield* new ThreadMoveError({ reason: "destination" });
            yield* writeStored(id, { ...stored, ready: true });
            return resultFor(stored.header);
          }
          const history = yield* readHistory(id);
          const checkout = path.join(config.worktreesDir, `moved-${id}`);
          yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
          // Before thread creation this path belongs solely to this transfer, so interrupted restores can restart.
          yield* fs.remove(checkout, { recursive: true, force: true });
          yield* workspaces.restore({
            staging: folder(id),
            cwd: checkout,
            snapshot: history.snapshot,
          });
          const cwd = path.join(checkout, history.snapshot.prefix);
          const projectId = ProjectId.make(`moved-${id}`);
          yield* projects.create({
            commandId: CommandId.make(`move:${id}:project`),
            projectId,
            title: stored.header.projectTitle ?? stored.header.title,
            workspaceRoot: cwd,
          });
          const now = yield* DateTime.now;
          const { header } = stored;
          const thread: OrchestrationV2AppThread = {
            id: threadId,
            projectId,
            title: header.title,
            modelSelection: header.modelSelection,
            providerInstanceId: header.modelSelection.instanceId,
            runtimeMode: header.runtimeMode,
            interactionMode: header.interactionMode,
            branch: history.snapshot.branch,
            worktreePath: cwd,
            activeProviderThreadId: null,
            historyOrigin: "portable_import",
            forkedFrom: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            createdBy: "user",
            creationSource: "server",
            createdAt: now,
            updatedAt: now,
            archivedAt: now,
            settledOverride: "active",
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
            move: {
              id,
              direction: "incoming",
              phase: "preparing",
              environmentId: header.sourceEnvironmentId,
              threadId: header.sourceThreadId,
              label: header.sourceLabel,
              startedAt: DateTime.formatIso(now),
              modelSelection: header.modelSelection,
              resumeAtReset: header.resumeAtReset,
              resetAt: history.limit?.failure.resetAt ?? null,
              ...(header.resume === true ? { resume: true } : {}),
            },
            limitRecovery: history.limit?.failure.resetAt
              ? {
                  requestId: CommandId.make(`move:${id}:recovery`),
                  runId: RunId.make(`${threadId}:limited`),
                  resetAt: history.limit.failure.resetAt,
                  autoResume: header.resumeAtReset,
                  snooze: false,
                }
              : null,
          };
          const imported = importedMoveEvents({ header, history, thread });
          yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
          for (const [index, attachment] of imported.attachments.entries()) {
            const target = resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment,
            });
            if (target === null) return yield* new ThreadMoveError({ reason: "unsupported" });
            const file = path.join(folder(id), `attachment-${index}`);
            if (Number((yield* fs.stat(file)).size) !== attachment.sizeBytes)
              return yield* new ThreadMoveError({ reason: "transfer" });
            yield* fs.copyFile(file, target);
          }
          yield* threadLocks.withLock(
            threadId,
            events.write({
              events: [
                {
                  id: EventId.make(`move:${id}:thread`),
                  type: "thread.created",
                  threadId,
                  occurredAt: now,
                  payload: thread,
                },
                ...imported.events,
              ],
            }),
          );
          yield* writeStored(id, { ...stored, ready: true });
          return resultFor(header);
        }).pipe(Effect.mapError(transferError)),
      );
    },
  );

  const activate: ThreadMoveService["Service"]["activate"] = Effect.fn(
    "ThreadMoveService.activate",
  )(function (owner, id) {
    return operations.withLock(
      id,
      Effect.gen(function* () {
        const stored = yield* readStored(owner, id);
        if (!stored.ready) return yield* new ThreadMoveError({ reason: "transfer" });
        const threadId = moveThreadId(id);
        yield* threadLocks.withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* projections.getThread(threadId);
            if (thread.move?.id !== id || thread.move.direction !== "incoming")
              return yield* new ThreadMoveError({ reason: "destination" });
            if (thread.move.phase === "complete") return;
            yield* publishThread(
              { ...thread, archivedAt: null, move: { ...thread.move, phase: "complete" } },
              "activated",
            );
          }),
        );
        // A retried activation replays this command's receipt instead of starting a second turn.
        if (stored.header.resume === true)
          yield* management
            .dispatch(
              continueCommand(
                threadId,
                id,
                `Your last turn was stopped so this thread could move here from ${stored.header.sourceLabel}. The conversation and workspace came with it; commands that were running did not. Continue where you left off.`,
              ),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Moved thread could not continue", { threadId, cause }),
              ),
            );
        return resultFor(stored.header);
      }).pipe(Effect.mapError(transferError)),
    );
  });

  const discard: ThreadMoveService["Service"]["discard"] = Effect.fn("ThreadMoveService.discard")(
    function (owner, id) {
      return operations.withLock(
        id,
        Effect.gen(function* () {
          const stored = yield* readStored(owner, id);
          const threadId = moveThreadId(id);
          yield* threadLocks.withLock(
            threadId,
            Effect.gen(function* () {
              const thread = yield* projections.getThreadShell(threadId);
              if (thread?.move?.phase === "complete")
                return yield* new ThreadMoveError({ reason: "committed" });
              if (thread !== null) {
                // A prepared destination is kept archived as recovery evidence; cancellation never starts it.
                yield* publishThread(
                  { ...(yield* projections.getThread(threadId)), deletedAt: yield* DateTime.now },
                  "cancelled",
                );
              }
            }),
          );
          yield* fs.remove(path.join(config.worktreesDir, `moved-${stored.header.id}`), {
            recursive: true,
            force: true,
          });
          yield* fs.remove(folder(id), { recursive: true, force: true });
        }).pipe(Effect.mapError(transferError)),
      );
    },
  );

  const peerCall = Effect.fn("ThreadMoveService.peerCall")(function* (
    target: { url: string; token: string },
    id: string,
    action: string,
    body?: unknown,
  ) {
    const response = yield* http.execute(
      HttpClientRequest.post(`${target.url}${MOVE_ROUTE}/${id}/${action}`).pipe(
        HttpClientRequest.bearerToken(target.token),
        HttpClientRequest.bodyText(yield* encodeBody(body ?? {}), "application/json"),
      ),
    );
    if (response.status !== 200) return yield* new ThreadMoveError({ reason: "destination" });
    return yield* response.json;
  });
  const sendFile = Effect.fn("ThreadMoveService.sendFile")(function* (
    target: { url: string; token: string },
    id: string,
    name: string,
    file: string,
  ) {
    const size = Number((yield* fs.stat(file)).size);
    if (size > (name === "history.json" ? MAX_HISTORY_BYTES : MAX_FILE_BYTES))
      return yield* new ThreadMoveError({ reason: "unsupported" });
    const response = yield* http.execute(
      HttpClientRequest.put(`${target.url}${MOVE_ROUTE}/${id}/${name}`).pipe(
        HttpClientRequest.bearerToken(target.token),
        HttpClientRequest.bodyStream(fs.stream(file), {
          contentType: "application/octet-stream",
          contentLength: size,
        }),
      ),
    );
    if (response.status !== 200) return yield* new ThreadMoveError({ reason: "transfer" });
    yield* response.text;
  });

  const models = Effect.fn("ThreadMoveService.models")(function* (environmentId: EnvironmentId) {
    const target = yield* links.resolve(environmentId);
    if (!(yield* links.enabled) || target.link.access !== "full-access" || environmentId === here)
      return yield* new ThreadMoveError({ reason: "destination" });
    const response = yield* http.execute(
      HttpClientRequest.post(`${target.url}${MOVE_ROUTE}/catalog`).pipe(
        HttpClientRequest.bearerToken(target.token),
      ),
    );
    if (response.status !== 200) return yield* new ThreadMoveError({ reason: "destination" });
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ThreadMoveModels)));
  }, Effect.mapError(transferError));

  const destinationCapacity = Effect.fn("ThreadMoveService.destinationCapacity")(function* (
    environmentId: EnvironmentId,
  ) {
    const target = yield* links.resolve(environmentId);
    if (!(yield* links.enabled) || target.link.access !== "full-access" || environmentId === here)
      return yield* new ThreadMoveError({ reason: "destination" });
    const response = yield* http.execute(
      HttpClientRequest.post(`${target.url}${MOVE_ROUTE}/capacity`).pipe(
        HttpClientRequest.bearerToken(target.token),
      ),
    );
    if (response.status !== 200) return yield* new ThreadMoveError({ reason: "destination" });
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(HostResourcesSnapshot)),
    );
  }, Effect.mapError(transferError));

  const stopForMove = Effect.fn("ThreadMoveService.stopForMove")(function* (threadId: ThreadId) {
    const source = yield* projections.getThreadRecords(threadId, SOURCE_RECORDS);
    if (source.thread.move?.direction === "outgoing") return false;
    const blocked = moveBlocker(source);
    if (blocked !== null) return yield* new ThreadMoveError({ reason: blocked });
    if (!isWorking(source)) return false;
    yield* management.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`move-stop:${yield* random.uuidV4()}`),
      threadId,
      reason: "Moving this thread to another machine.",
    });
    yield* management.waitForThread({
      projectId: source.thread.projectId,
      threadId,
      timeoutMs: 60_000,
      untilDelegatedWorkSettled: true,
    });
    return true;
  });

  const move = Effect.fn("ThreadMoveService.move")(function (
    input: ThreadMoveInput,
    automatic = false,
  ) {
    return operations.withLock(
      `source:${input.threadId}`,
      Effect.gen(function* () {
        const target = yield* links.resolve(input.destinationEnvironmentId);
        if (target.link.access !== "full-access" || input.destinationEnvironmentId === here)
          return yield* new ThreadMoveError({ reason: "destination" });
        const stopped = yield* stopForMove(input.threadId);
        const moveState = yield* threadLocks.withLock(
          input.threadId,
          Effect.gen(function* () {
            const source = yield* projections.getThreadRecords(input.threadId, [
              ...SOURCE_RECORDS,
              "turnItems",
            ]);
            if (source.thread.move?.direction === "outgoing") {
              if (automatic && source.thread.move.automatic !== true)
                return yield* new ThreadMoveError({ reason: "busy" });
              if (source.thread.move.environmentId !== input.destinationEnvironmentId)
                return yield* new ThreadMoveError({ reason: "committed" });
              return source.thread.move;
            }
            const blocked = moveBlocker(source);
            if (blocked !== null) return yield* new ThreadMoveError({ reason: blocked });
            if (isWorking(source)) return yield* new ThreadMoveError({ reason: "busy" });
            const now = yield* DateTime.now;
            const id = yield* random.uuidV4();
            const failure = latestRootProviderFailure(
              latestExecutedRun(source.runs),
              source.turnItems,
            );
            const state = {
              id,
              direction: "outgoing" as const,
              phase: "preparing" as const,
              automatic,
              environmentId: input.destinationEnvironmentId,
              threadId: moveThreadId(id),
              label: target.link.label,
              startedAt: DateTime.formatIso(now),
              modelSelection: input.modelSelection ?? source.thread.modelSelection,
              resumeAtReset: input.resumeAtReset,
              resetAt: failure?.class === "usage_limit" ? (failure.resetAt ?? null) : null,
              ...(stopped ? { resume: true } : {}),
            };
            yield* publishThread({ ...source.thread, archivedAt: now, move: state }, "preparing");
            return state;
          }),
        );
        const id = moveState.id;
        const result: ThreadMoveResult = {
          environmentId: moveState.environmentId,
          threadId: moveState.threadId,
          label: moveState.label,
          link: `t3-thread://v2/${encodeURIComponent(moveState.environmentId)}/${encodeURIComponent(moveState.threadId)}`,
        };
        if (moveState.phase === "complete") return result;
        if (moveState.phase === "preparing") {
          const source = yield* projections.getThreadRecords(input.threadId, [
            "runs",
            "attempts",
            "turnItems",
          ]);
          const descriptor = yield* environment.getDescriptor;
          const project = yield* projects.getById(source.thread.projectId);
          if (Option.isNone(project)) return yield* new ThreadMoveError({ reason: "unsupported" });
          const header: MoveHeader = {
            id,
            sourceEnvironmentId: here,
            sourceThreadId: input.threadId,
            sourceLabel: descriptor.label,
            title: source.thread.title,
            ...(project.value.title.length > 0 && project.value.title.length <= 1000
              ? { projectTitle: project.value.title }
              : {}),
            modelSelection: moveState.modelSelection,
            runtimeMode: source.thread.runtimeMode,
            interactionMode: source.thread.interactionMode,
            resumeAtReset: moveState.resumeAtReset,
            ...(moveState.resume === true ? { resume: true } : {}),
          };
          yield* peerCall(target, id, "begin", header);
          yield* fs.makeDirectory(folder(id), { recursive: true });
          // Retain a frozen package so retries never capture edits made after the move began.
          if (!(yield* fs.exists(path.join(folder(id), "history.json")))) {
            const snapshot = yield* workspaces.capture({
              cwd: source.thread.worktreePath ?? project.value.workspaceRoot,
              staging: folder(id),
            });
            const all = [
              ...(yield* readInheritedHandoffItems(projections, source.thread)),
              ...visibleConversationItems(source, source.turnItems),
            ];
            const items = all.flatMap((item) => {
              const value = portableItem(item);
              return value === null ? [] : [value];
            });
            const attachments = [
              ...new Map(
                items
                  .flatMap((item) =>
                    item.type === "user_message" || item.type === "assistant_message"
                      ? (item.attachments ?? [])
                      : [],
                  )
                  .map((file) => [file.id, file]),
              ).values(),
            ];
            const latest = latestExecutedRun(source.runs);
            const failure = latestRootProviderFailure(latest, source.turnItems);
            const history: MoveHistory = {
              snapshot,
              items,
              attachments,
              limit:
                failure?.class === "usage_limit" &&
                failure.resetAt != null &&
                latest?.completedAt != null
                  ? { failure, completedAt: DateTime.formatIso(latest.completedAt) }
                  : null,
            };
            for (const [index, attachment] of attachments.entries()) {
              const file = resolveAttachmentPath({
                attachmentsDir: config.attachmentsDir,
                attachment,
              });
              if (file === null) return yield* new ThreadMoveError({ reason: "unsupported" });
              yield* fs.copyFile(file, path.join(folder(id), `attachment-${index}`));
            }
            const historyJson = yield* encodeHistory(history);
            if (new TextEncoder().encode(historyJson).byteLength > MAX_HISTORY_BYTES)
              return yield* new ThreadMoveError({ reason: "unsupported" });
            yield* fs.writeFileString(path.join(folder(id), "history.json.part"), historyJson, {
              mode: 0o600,
            });
            yield* fs.rename(
              path.join(folder(id), "history.json.part"),
              path.join(folder(id), "history.json"),
            );
          }
          const history = yield* readHistory(id);
          for (const name of [
            "workspace.bundle",
            "staged.patch",
            "history.json",
            ...history.attachments.map((_, index) => `attachment-${index}`),
          ])
            yield* sendFile(target, id, name, path.join(folder(id), name));
          yield* peerCall(target, id, "prepare").pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ThreadMoveResult)),
          );
          // Activation is sent only after this commit; an ambiguous response must never thaw the source.
          yield* threadLocks.withLock(
            input.threadId,
            Effect.gen(function* () {
              const thread = yield* projections.getThread(input.threadId);
              yield* publishThread(
                { ...thread, move: { ...moveState, phase: "committed" } },
                "committed",
              );
            }),
          );
        }
        yield* peerCall(target, id, "activate").pipe(
          Effect.mapError((cause) => new ThreadMoveError({ reason: "committed", cause })),
        );
        yield* threadLocks.withLock(
          input.threadId,
          Effect.gen(function* () {
            const thread = yield* projections.getThread(input.threadId);
            yield* publishThread(
              { ...thread, limitRecovery: null, move: { ...moveState, phase: "complete" } },
              "complete",
            );
          }),
        );
        yield* fs.remove(folder(id), { recursive: true, force: true }).pipe(Effect.ignore);
        return result;
      }).pipe(Effect.mapError(transferError)),
    );
  });
  const moveAutomatically: ThreadMoveService["Service"]["moveAutomatically"] = (input) =>
    move(input, true);

  const cancel: ThreadMoveService["Service"]["cancel"] = Effect.fn("ThreadMoveService.cancel")(
    function (threadId) {
      return operations.withLock(
        `source:${threadId}`,
        threadLocks
          .withLock(
            threadId,
            Effect.gen(function* () {
              const thread = yield* projections.getThread(threadId);
              const state = thread.move;
              if (state == null) return null;
              if (state.direction !== "outgoing" || state.phase !== "preparing")
                return yield* new ThreadMoveError({ reason: "committed" });
              // The destination cannot activate before a committed source, so offline cancellation is safe.
              yield* publishThread({ ...thread, archivedAt: null, move: null }, "cancelled");
              yield* fs
                .remove(folder(state.id), { recursive: true, force: true })
                .pipe(Effect.ignore);
              return state;
            }),
          )
          .pipe(
            // Best effort: an unreachable destination keeps its prepared copy archived, never active.
            Effect.tap((state) =>
              state == null
                ? Effect.void
                : links.resolve(state.environmentId).pipe(
                    Effect.flatMap((target) => peerCall(target, state.id, "discard")),
                    Effect.timeout("10 seconds"),
                    Effect.ignore,
                  ),
            ),
            Effect.tap((state) =>
              state?.resume === true
                ? management
                    .dispatch(
                      continueCommand(
                        threadId,
                        `${state.id}:source`,
                        "Your last turn was stopped to move this thread to another machine, and the move was cancelled. Continue where you left off.",
                      ),
                    )
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Thread could not continue after a cancelled move", {
                          threadId,
                          cause,
                        }),
                      ),
                    )
                : Effect.void,
            ),
            Effect.asVoid,
            Effect.mapError(transferError),
          ),
      );
    },
  );

  let nextSampleAt = 0;
  let highLoadSince: number | null = null;
  let nextMoveAt = 0;
  const automaticSweep = Effect.fn("ThreadMoveService.automaticSweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs < nextSampleAt) return;
    if (nowMs - nextSampleAt > LOAD_SAMPLE_INTERVAL_MS * 2) highLoadSince = null;
    nextSampleAt = nowMs + LOAD_SAMPLE_INTERVAL_MS;
    const pending = yield* projections.getPendingAutomaticMoves();
    for (const thread of pending) {
      const state = thread.move;
      if (state == null) continue;
      yield* moveAutomatically({
        threadId: thread.id,
        destinationEnvironmentId: state.environmentId,
        resumeAtReset: state.resumeAtReset,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic thread move needs retry", { threadId: thread.id, cause }),
        ),
      );
    }
    const preferences = yield* settings.getSettings;
    if (!preferences.autoMoveThreadsOnHighLoad || !(yield* links.enabled)) {
      highLoadSince = null;
      return;
    }
    const local = yield* resources.read;
    if (!isOverloaded(local)) {
      highLoadSince = null;
      return;
    }
    highLoadSince ??= nowMs;
    if (nowMs - highLoadSince < SUSTAINED_LOAD_MS || nowMs < nextMoveAt || pending.length > 0)
      return;
    nextMoveAt = nowMs + SUSTAINED_LOAD_MS;
    const candidates = (yield* links.list).filter(
      (link) => link.access === "full-access" && link.status === "reachable",
    );
    const destinations = yield* Effect.forEach(
      candidates,
      (link) =>
        Effect.gen(function* () {
          const snapshot = yield* destinationCapacity(link.environmentId);
          if (!hasSpareCapacity(snapshot)) return null;
          return { link, snapshot, models: yield* models(link.environmentId) };
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 2 },
    );
    const available = destinations
      .filter((value) => value !== null)
      .sort(
        (left, right) => (left.snapshot.cpuUtilization ?? 1) - (right.snapshot.cpuUtilization ?? 1),
      );
    if (available.length === 0) return;
    const shell = yield* projections.getShellSnapshot({ location: "active", unsettledOnly: true });
    // A working thread is likely what loads the machine; it stops here and continues there.
    const threads = shell.threads
      .filter((thread) => canAutomaticallyMove(thread, shell.threads, nowMs))
      .sort(
        (left, right) =>
          Number(isWorkingShell(right)) - Number(isWorkingShell(left)) ||
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      );
    for (const thread of threads) {
      const destination = available.find(({ models }) =>
        models.some(
          ({ selection }) =>
            selection.instanceId === thread.modelSelection.instanceId &&
            selection.model === thread.modelSelection.model,
        ),
      );
      if (destination === undefined) continue;
      const moved = yield* moveAutomatically({
        threadId: thread.id,
        destinationEnvironmentId: destination.link.environmentId,
        modelSelection: thread.modelSelection,
        resumeAtReset: thread.limitRecovery?.autoResume ?? false,
      }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const current = yield* projections.getThread(thread.id);
            if (current.move?.direction === "outgoing" && current.move.phase === "preparing")
              yield* cancel(thread.id);
            yield* Effect.logWarning("Automatic thread move did not finish", {
              threadId: thread.id,
              cause,
            });
            // A thread that could not leave before handoff lets the next candidate try.
            return current.move?.phase === "committed";
          }),
        ),
      );
      if (moved) return;
    }
  });

  yield* scheduler.register("thread-move-load-balancer", automaticSweep());

  return ThreadMoveService.of({
    move,
    moveAutomatically,
    cancel,
    catalog,
    models,
    capacity,
    destinationCapacity,
    begin,
    upload,
    prepare,
    activate,
    discard,
  });
});

export const layer = Layer.effect(ThreadMoveService, make);
