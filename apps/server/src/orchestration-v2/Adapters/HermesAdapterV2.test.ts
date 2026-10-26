import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  HermesSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { parseSessionUpdateEvent } from "@t3tools/provider-acp/server/runtimeModel";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  discardLostHermesTurnsOnPrompt,
  makeHermesAcpRuntime,
} from "../../provider/acp/HermesAcpSupport.ts";
import delegationFixture from "../../provider/acp/fixtures/hermes-delegation.json" with { type: "json" };
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  HermesProviderCapabilitiesV2,
  hermesSpawnEnvironment,
  makeHermesAcpAdapterFlavor,
  makeHermesAdapterV2,
  type HermesAdapterV2Options,
} from "./HermesAdapterV2.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const hermesSettings = (binaryPath: string) => decodeHermesSettings({ binaryPath });
const decodeRequestLine = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Unknown),
    }),
  ),
);
const instanceId = ProviderInstanceId.make("hermes-v2-test");

function runtimePolicy(runtimeMode: RuntimeMode, cwd = process.cwd()) {
  return ProviderAdapterV2RuntimePolicy.make({ runtimeMode, interactionMode: "default", cwd });
}

function turnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection>;
  readonly ordinal?: number;
}): ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection = {
    instanceId,
    model: input.model,
    ...(input.options === undefined ? {} : { options: input.options }),
  };
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "Hermes adapter test",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: input.runtimePolicy.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  } as ProviderAdapterV2TurnInput;
}

/**
 * Runs one turn against the mock ACP agent behind a stand-in `hermes` binary,
 * so the real spawn path (`hermes acp`, environment) is exercised.
 */
const runMockTurn = (input: {
  readonly name: string;
  readonly mockEnvironment: Record<string, string>;
  readonly runtimeMode?: RuntimeMode;
  readonly model?: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection>;
  readonly continuationRequests?: HermesAdapterV2Options["continuationRequests"];
  /**
   * Session updates the prompt delivers instead of the mock's own reply, for
   * Hermes's ACP v1 shapes (`tool_call`) the v2 mock cannot send.
   */
  readonly promptUpdates?: ReadonlyArray<EffectAcpSchema.SessionUpdate>;
  /**
   * Session updates delivered after the first turn ends, with no prompt open: what the Hermes
   * gateway projects when it runs a turn of its own for a finished background job.
   */
  readonly idleUpdates?: ReadonlyArray<EffectAcpSchema.SessionUpdate>;
  /** Runs the buffered continuation the idle updates offered, through its quiet window. */
  readonly runContinuation?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-v2-" });
    const binaryPath = path.join(dir, "hermes");
    yield* fileSystem.writeFileString(
      binaryPath,
      `#!/bin/sh\nexec '${process.execPath}' '${mockAgentPath}' "$@"\n`,
    );
    yield* fileSystem.chmod(binaryPath, 0o755);
    const requestLogPath = path.join(dir, "requests.ndjson");
    const settings = hermesSettings(binaryPath);
    const environment = {
      ...process.env,
      // Point the reasoning write at the temp dir, never a real profile.
      HERMES_HOME: dir,
      T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      T3_ACP_MODEL_IDS: "hermes-4:Hermes 4,openai/gpt-5:GPT-5",
      ...input.mockEnvironment,
    };
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const promptUpdates = input.promptUpdates;
    const idleUpdates = input.idleUpdates;
    let sessionIdSeen: string | undefined;
    type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
    let deliver: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
    const adapter = yield* makeHermesAdapterV2({
      instanceId,
      settings,
      environment,
      ...(promptUpdates === undefined && idleUpdates === undefined
        ? {}
        : {
            makeRuntime: ({ runtimePolicy: _policy, ...runtimeInput }) =>
              makeHermesAcpRuntime({
                ...runtimeInput,
                hermesSettings: settings,
                environment,
                childProcessSpawner,
              }).pipe(
                Effect.map((runtime): Runtime => ({
                  ...runtime,
                  handleSessionUpdate: (handler) =>
                    Effect.sync(() => {
                      deliver = handler;
                    }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                  prompt: () =>
                    Effect.gen(function* () {
                      const { sessionId } = yield* runtime.start();
                      sessionIdSeen = sessionId;
                      for (const update of promptUpdates ?? [])
                        yield* deliver!({ sessionId, update });
                      return { stopReason: "end_turn" as const };
                    }),
                })),
              ),
          }),
      childProcessSpawner,
      selfInvocation: yield* resolveSelfInvocation(),
      ...(input.continuationRequests === undefined
        ? {}
        : { continuationRequests: input.continuationRequests }),
    });
    const threadId = ThreadId.make(`hermes-v2-${input.name}`);
    const policy = runtimePolicy(input.runtimeMode ?? "approval-required");
    const modelSelection = {
      instanceId,
      model: input.model ?? "hermes-4",
      ...(input.options === undefined ? {} : { options: input.options }),
    };
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`hermes-v2-session-${input.name}`),
      modelSelection,
      runtimePolicy: policy,
    });
    const providerThread = yield* session.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: policy,
    });
    yield* session.startTurn(
      turnInput({
        threadId,
        providerThread,
        runtimePolicy: policy,
        now: yield* DateTime.now,
        model: modelSelection.model,
        ...(input.options === undefined ? {} : { options: input.options }),
      }),
    );
    const untilTerminal = session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const events: Array<ProviderAdapterV2Event> = Array.from(yield* untilTerminal);
    for (const update of idleUpdates ?? []) {
      yield* deliver!({ sessionId: sessionIdSeen!, update });
    }
    if (input.runContinuation === true) {
      const continuation = turnInput({
        threadId,
        providerThread,
        runtimePolicy: policy,
        now: yield* DateTime.now,
        model: modelSelection.model,
        ordinal: 2,
      });
      yield* session.startTurn({
        ...continuation,
        message: {
          ...continuation.message,
          createdBy: "agent",
          creationSource: "provider",
          text: "Background activity updated",
        },
      });
      yield* TestClock.adjust("3 seconds");
      events.push(...(yield* untilTerminal));
    }
    const requests = (yield* fileSystem.readFileString(requestLogPath))
      .trim()
      .split("\n")
      .map((line) => decodeRequestLine(line));
    return { threadId, events, requests };
  });

describe("HermesAdapterV2 flavor", () => {
  const flavor = makeHermesAcpAdapterFlavor({
    environment: {},
  } as unknown as Parameters<typeof makeHermesAcpAdapterFlavor>[0]);

  it("compacts with Hermes's own command and sends images whatever the handshake says", () => {
    assert.equal(flavor.compactionCommand, "/compress");
    assert.isTrue(flavor.supportsCompaction);
    assert.isTrue(flavor.supportsImagePrompts);
    assert.isTrue(HermesProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(HermesProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    // Steering interrupts and re-prompts, like every ACP flavor.
    assert.isFalse(HermesProviderCapabilitiesV2.turns.supportsActiveSteering);
  });

  it("turns on Hermes YOLO only for full-access sessions so subagents follow it", () => {
    assert.equal(hermesSpawnEnvironment({}, "full-access").HERMES_YOLO_MODE, "1");
    for (const mode of ["approval-required", "auto-accept-edits"] as const) {
      assert.isUndefined(hermesSpawnEnvironment({}, mode).HERMES_YOLO_MODE);
    }
  });

  it("keeps a skill row's name on the turn item title", () => {
    const event = parseSessionUpdateEvent({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-skill",
        title: "skill view (pr-review)",
        kind: "read",
        status: "completed",
      },
    }).events[0];
    if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call");
    assert.notEqual(event.toolCall.title, "skill view (pr-review)");
    assert.equal(flavor.normalizeToolCall?.(event.toolCall).title, "skill view (pr-review)");
  });
});

describe.skipIf(windowsHost)("HermesAdapterV2 against the mock agent", () => {
  it.effect("selects the requested model and streams the reply", () =>
    Effect.gen(function* () {
      const { events, requests } = yield* runMockTurn({
        name: "model",
        model: "openai/gpt-5",
        mockEnvironment: { T3_ACP_EMIT_USAGE_UPDATE: "48120/200000" },
      });
      // The v2 mock takes the model as a config option; real Hermes (ACP v1)
      // gets `session/set_model` through the same selection.
      const setModel = requests.find(
        (request) =>
          request.method === "session/set_config_option" &&
          (request.params as { readonly value?: unknown }).value === "openai/gpt-5",
      );
      assert.isDefined(setModel);
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
      const replies = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.include(replies.at(-1) ?? "", "hello from mock");
      const usage = events.flatMap((event) =>
        event.type === "provider_thread.updated" && event.providerThread.contextUsage
          ? [event.providerThread.contextUsage]
          : [],
      );
      assert.deepInclude(usage.at(-1) ?? {}, { usedTokens: 48_120, maxTokens: 200_000 });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sends the fast-mode choice as Hermes's session option once", () =>
    Effect.gen(function* () {
      const { events, requests } = yield* runMockTurn({
        name: "fast",
        model: "openai/gpt-5",
        options: [{ id: "fastMode", value: true }],
        mockEnvironment: {},
      });
      const fastMode = requests.filter(
        (request) =>
          request.method === "session/set_config_option" &&
          (request.params as { readonly configId?: unknown }).configId === "fast_mode",
      );
      // Session open and turn start both apply the selection; Hermes hears it once.
      assert.deepEqual(
        fastMode.map((request) => (request.params as { readonly value?: unknown }).value),
        ["on"],
      );
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("leaves Hermes's fast mode alone when the toggle was never touched", () =>
    Effect.gen(function* () {
      const { requests } = yield* runMockTurn({ name: "no-fast", mockEnvironment: {} });
      assert.isFalse(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            (request.params as { readonly configId?: unknown }).configId === "fast_mode",
        ),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("projects each child of a delegate batch as a subagent, not a tool row", () =>
    Effect.gen(function* () {
      const batch = delegationFixture.cases.find((item) => item.name === "batch")!;
      const toolCallId = batch.start.toolCallId;
      const progress = (hermesDelegation: Record<string, unknown>) =>
        ({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          rawOutput: { hermesDelegation },
        }) as const;
      const { threadId, events } = yield* runMockTurn({
        name: "delegation",
        mockEnvironment: {},
        promptUpdates: [
          { ...batch.start, rawInput: batch.args } as EffectAcpSchema.SessionUpdate,
          progress({ event: "subagent.start", task_index: 0 }),
          progress({ event: "subagent.text", task_index: 0, text: "Inspecting the boundary." }),
          progress({ event: "subagent.thinking", task_index: 1, text: "(¬‿¬) analyzing..." }),
          progress({
            event: "subagent.complete",
            task_index: 0,
            status: "completed",
            summary: "Routing inspected.",
            input_tokens: 9_000,
            output_tokens: 3_400,
            duration_seconds: 1.5,
          }),
          { ...batch.complete, rawOutput: batch.result } as EffectAcpSchema.SessionUpdate,
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
        ],
      });
      const latest = new Map<string, OrchestrationV2Subagent>();
      for (const event of events) {
        if (event.type !== "subagent.updated") continue;
        latest.set(String(event.subagent.id), event.subagent);
      }
      assert.deepEqual(
        [...latest.values()].map(({ title, status, role, usage }) => [title, status, role, usage]),
        [
          [
            "Inspect routing",
            "completed",
            "orchestrator",
            { totalTokens: 12_400, inputTokens: 9_000, outputTokens: 3_400, durationMs: 1_500 },
          ],
          ["Run tests", "failed", "leaf", { durationMs: 2_000 }],
        ],
      );
      const delegateRows = events.filter(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.threadId === threadId &&
          event.turnItem.title?.startsWith("delegate"),
      );
      assert.lengthOf(delegateRows, 0);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("shows Hermes's T3 tool calls as T3's, with the ids its summary dropped", () =>
    Effect.gen(function* () {
      // Hermes's gateway reports the call under a per-session server name, starts it with no
      // status, and completes it with a truncated markdown summary instead of the result.
      const args = { task: "Review the diff", mode: "wait" };
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.recordToolResult(
        ThreadId.make("hermes-v2-t3-tool"),
        { tool: "delegate_task", input: { mode: "wait", task: "Review the diff" } },
        { taskId: "node:t3-tool-task", threadId: "thread:t3-tool-child" },
      );
      const title = "mcp__editor_t3_code_1a2b3c4d__delegate_task";
      const { events } = yield* runMockTurn({
        name: "t3-tool",
        mockEnvironment: {},
        promptUpdates: [
          {
            sessionUpdate: "tool_call",
            toolCallId: "tc-t3",
            title: `${title}: Review the diff`,
            kind: "other",
            rawInput: args,
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-t3",
            kind: "other",
            status: "completed",
            content: [
              {
                type: "content",
                content: { type: "text", text: `${title} result\n- **result:** {"taskId":"no` },
              },
            ],
          },
        ],
      });
      const rows = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        [rows.at(0), rows.at(-1)].map((row) => [row?.toolName, row?.status]),
        [
          ["t3-code.delegate_task", "running"],
          ["t3-code.delegate_task", "completed"],
        ],
      );
      assert.deepEqual(rows.at(-1)?.output, {
        taskId: "node:t3-tool-task",
        threadId: "thread:t3-tool-child",
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("offers a wake run for a turn the Hermes gateway runs after the prompt settled", () =>
    Effect.gen(function* () {
      const offers = yield* Queue.unbounded<ProviderContinuationRequest>();
      const { events } = yield* runMockTurn({
        name: "idle-gateway-turn",
        mockEnvironment: {},
        promptUpdates: [
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Queued." } },
        ],
        idleUpdates: [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The merge landed." },
          },
        ],
        continuationRequests: {
          offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
        },
        runContinuation: true,
      });
      // A flavor without post-settle continuation drops these frames: the agent works, the thread stays blank.
      assert.equal(yield* Queue.size(offers), 1);
      const wakeEvents = events.slice(
        events.findIndex((event) => event.type === "turn.terminal") + 1,
      );
      assert.isTrue(
        wakeEvents.some(
          (event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text.includes("The merge landed."),
        ),
      );
      const wakeTerminal = wakeEvents.at(-1);
      assert.equal(wakeTerminal?.type === "turn.terminal" && wakeTerminal.status, "completed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

const hermesPromptError = (details: string) =>
  new EffectAcpErrors.AcpRequestError({
    code: -32603,
    errorMessage: "Internal error",
    data: { details },
  });
const GATEWAY_DISCONNECTED =
  "Gateway disconnected; turn outcome is unknown. Resume the printed session ID to check whether it completed or was interrupted; do not resend the work.";
const lostTurnRefusal = (state: string) =>
  `unknown_execution: do not resend accepted input; a turn in this session was lost when the gateway restarted and its outcome is unknown (${state}). Send \`/discard lost-1\` here (or \`hermes sessions discard s\` in a terminal), then continue.`;
const promptText = (payload: { readonly prompt: ReadonlyArray<EffectAcpSchema.ContentBlock> }) =>
  payload.prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

describe("Hermes prompts blocked by a lost gateway turn", () => {
  type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
  const fakeRuntime = (prompt: Runtime["prompt"]) =>
    discardLostHermesTurnsOnPrompt({
      prompt: ((payload, options) =>
        Effect.suspend(() => prompt(payload, options))) satisfies Runtime["prompt"],
      handleSessionUpdate: () => Effect.void,
    } as unknown as Runtime);

  it.effect("discards the lost turn and resends a prompt Hermes did not submit", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const runtime = fakeRuntime((payload) => {
        const text = promptText(payload);
        sent.push(text);
        return sent.length === 1
          ? Effect.fail(hermesPromptError(lostTurnRefusal("nothing was submitted")))
          : Effect.succeed({ stopReason: "end_turn" as const });
      });
      const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "continue" }] });
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(sent, ["continue", "/discard lost-1", "continue"]);
    }),
  );

  it.effect("releases input Hermes queued behind the lost turn instead of failing it", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const shown: Array<string> = [];
      let deliver: Parameters<Runtime["handleSessionUpdate"]>[0] = () => Effect.void;
      const runtime = discardLostHermesTurnsOnPrompt({
        prompt: ((payload) =>
          Effect.suspend(() => {
            sent.push(promptText(payload));
            if (sent.length > 1) return Effect.succeed({ stopReason: "end_turn" as const });
            // A stale `hermes acp` reconnects inside the prompt and announces the lost turn.
            const notice = lostTurnRefusal("nothing was submitted").replace(
              "unknown_execution: ",
              "",
            );
            return deliver({
              sessionId: "s",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: notice },
              },
            }).pipe(
              Effect.andThen(
                Effect.fail(hermesPromptError(lostTurnRefusal("your input is accepted and kept"))),
              ),
            );
          })) satisfies Runtime["prompt"],
        handleSessionUpdate: (handler: Parameters<Runtime["handleSessionUpdate"]>[0]) =>
          Effect.sync(() => {
            deliver = handler;
          }),
      } as unknown as Runtime);
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.sync(() => {
          if (notification.update.sessionUpdate === "agent_message_chunk") shown.push("text");
        }),
      );
      const result = yield* runtime.prompt({ prompt: [{ type: "text", text: "continue" }] });
      // Discarding the lost turn runs the queued input; resending it would run it twice.
      assert.equal(result.stopReason, "end_turn");
      assert.deepEqual(sent, ["continue", "/discard lost-1"]);
      assert.deepEqual(shown, []);
    }),
  );

  it.effect("fails a prompt whose own running turn was lost", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      let deliver: Parameters<Runtime["handleSessionUpdate"]>[0] = () => Effect.void;
      const runtime = discardLostHermesTurnsOnPrompt({
        prompt: ((payload) =>
          Effect.suspend(() => {
            sent.push(promptText(payload));
            return deliver({
              sessionId: "s",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Working on it" },
              },
            }).pipe(
              Effect.andThen(
                Effect.fail(hermesPromptError(lostTurnRefusal("your input is accepted and kept"))),
              ),
            );
          })) satisfies Runtime["prompt"],
        handleSessionUpdate: (handler: Parameters<Runtime["handleSessionUpdate"]>[0]) =>
          Effect.sync(() => {
            deliver = handler;
          }),
      } as unknown as Runtime);
      yield* runtime.handleSessionUpdate(() => Effect.void);
      const exit = yield* Effect.exit(
        runtime.prompt({ prompt: [{ type: "text", text: "continue" }] }),
      );
      assert.isTrue(exit._tag === "Failure");
      assert.deepEqual(sent, ["continue"]);
    }),
  );

  it("names Hermes's own reason when it rejects a prompt", () => {
    const flavor = makeHermesAcpAdapterFlavor({
      environment: {},
    } as unknown as Parameters<typeof makeHermesAcpAdapterFlavor>[0]);
    assert.equal(
      flavor.promptFailure?.(hermesPromptError("admitted_turn_failed")).message,
      "Hermes: admitted_turn_failed",
    );
  });
});

describe.skipIf(windowsHost)("HermesAdapterV2 across a Hermes gateway restart", () => {
  it.effect(
    "explains the lost turn, then starts a fresh agent that clears it for the next message",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-restart-" });
        const binaryPath = path.join(dir, "hermes");
        yield* fileSystem.writeFileString(
          binaryPath,
          `#!/bin/sh\nexec '${process.execPath}' '${mockAgentPath}' "$@"\n`,
        );
        yield* fileSystem.chmod(binaryPath, 0o755);
        const settings = hermesSettings(binaryPath);
        const environment = { ...process.env, HERMES_HOME: dir };
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
        // Every `hermes acp` process the adapter starts, and the prompts each was sent.
        const spawned: Array<Array<string>> = [];
        let sessionId: string | undefined;
        const adapter = yield* makeHermesAdapterV2({
          instanceId,
          settings,
          environment,
          childProcessSpawner,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: ({ runtimePolicy: _policy, ...runtimeInput }) =>
            makeHermesAcpRuntime({
              ...runtimeInput,
              hermesSettings: settings,
              environment,
              childProcessSpawner,
            }).pipe(
              Effect.map((runtime): Runtime => {
                const prompts: Array<string> = [];
                const processIndex = spawned.push(prompts) - 1;
                let deliver: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
                const say = (text: string) =>
                  deliver!({
                    sessionId: sessionId!,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text },
                    },
                  });
                return {
                  ...runtime,
                  handleSessionUpdate: (handler) =>
                    Effect.sync(() => {
                      deliver = handler;
                    }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                  prompt: (payload) =>
                    Effect.gen(function* () {
                      sessionId ??= (yield* runtime.start()).sessionId;
                      const text = promptText(payload);
                      prompts.push(text);
                      // The first process was attached when the gateway restarted mid-turn.
                      if (processIndex === 0) {
                        return yield* hermesPromptError(GATEWAY_DISCONNECTED);
                      }
                      if (text === "/discard lost-1") {
                        yield* say("Discarded the lost turn. Queued messages can continue.\n");
                        return { stopReason: "end_turn" as const };
                      }
                      if (!prompts.includes("/discard lost-1")) {
                        return yield* hermesPromptError(lostTurnRefusal("nothing was submitted"));
                      }
                      yield* say("Picking up where we left off.");
                      return { stopReason: "end_turn" as const };
                    }),
                };
              }),
            ),
        });
        const threadId = ThreadId.make("hermes-v2-gateway-restart");
        const policy = runtimePolicy("approval-required");
        const modelSelection = { instanceId, model: "hermes-4" };
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("hermes-v2-session-gateway-restart"),
          modelSelection,
          runtimePolicy: policy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: policy,
        });
        const runTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* session.startTurn(
              turnInput({
                threadId,
                providerThread,
                runtimePolicy: policy,
                now: yield* DateTime.now,
                model: modelSelection.model,
                ordinal,
              }),
            );
            return Array.from(
              yield* session.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              ),
            );
          });

        const lost = (yield* runTurn(1)).at(-1);
        assert.equal(lost?.type === "turn.terminal" && lost.status, "failed");
        assert.include(
          lost?.type === "turn.terminal" ? (lost.failure?.message ?? "") : "",
          "Hermes gateway restarted",
        );

        const next = yield* runTurn(2);
        const terminal = next.at(-1);
        assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
        // A fresh process reads the lost turn on load, so nothing is queued behind it unseen.
        assert.equal(spawned.length, 2);
        assert.deepEqual(
          spawned[1]!.map((text) => (text.includes("test prompt") ? "test prompt" : text)),
          ["test prompt", "/discard lost-1", "test prompt"],
        );
        const replies = next.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        );
        assert.include(replies.at(-1) ?? "", "Picking up where we left off.");
        assert.notInclude(replies.join("\n"), "Discarded the lost turn");
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
