// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  hermesPromptSettlementBelongsToContext,
  makeHermesAdapter,
  makeHermesAttachmentPromptPart,
} from "./HermesAdapter.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const HERMES_MOCK_MODELS = "hermes-4:Hermes 4,openai/gpt-5:GPT-5";

/**
 * Stand-in for the `hermes` binary. The wrapper takes `acp` as its argument
 * exactly like the real CLI and execs the shared mock ACP agent.
 */
async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes.sh");
  const envExports = Object.entries({ T3_ACP_MODEL_IDS: HERMES_MOCK_MODELS, ...extraEnv })
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 40): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (raw.trim().length > 0) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ enabled: true, binaryPath }), options).pipe(
    Effect.orDie,
  );

it("requires a settlement to match the live Hermes turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    hermesPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it("keeps image attachments inline in Hermes ACP prompts", () => {
  assert.deepStrictEqual(
    makeHermesAttachmentPromptPart({
      attachment: {
        type: "image",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
      attachmentPath: "/tmp/diagram.png",
      imageBytes: Uint8Array.from([1, 2, 3]),
    }),
    { type: "image", data: "AQID", mimeType: "image/png" },
  );
});

it("sends generic files to Hermes as local ACP resource links", () => {
  const attachmentPath = NodePath.join(NodeOS.tmpdir(), "Hermes notes #1.txt");

  assert.deepStrictEqual(
    makeHermesAttachmentPromptPart({
      attachment: {
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
      attachmentPath,
    }),
    {
      type: "resource_link",
      uri: NodeURL.pathToFileURL(attachmentPath).href,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 42,
    },
  );
});

it.layer(hermesAdapterTestLayer)("HermesAdapterLive", (it) => {
  it.effect("starts a session and maps the mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });

      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "openai/gpt-5");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps ACP usage_update and Hermes compaction onto thread runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-usage-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "48120/200000",
          T3_ACP_EMIT_COMPACTION_INFO: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const usageSeen = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "thread.token-usage.updated"
              ? Deferred.succeed(usageSeen, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });
      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });

      // Wait on the usage receipt itself rather than the turn, since Hermes
      // sends usage_update after the assistant message.
      yield* Deferred.await(usageSeen);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usage = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.isDefined(usage);
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 48_120);
        assert.equal(usage.payload.usage.maxTokens, 200_000);
        assert.equal(usage.payload.usage.compactsAutomatically, true);
      }

      const compacted = runtimeEvents.find(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      assert.isDefined(compacted, "expected a compacted thread.state.changed event");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("folds session/prompt usage totals into the context-window snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-usage-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "48120/200000",
          // input/output/total/cachedRead/thought, shaped like Hermes's
          // PromptResponse.usage.
          T3_ACP_EMIT_PROMPT_USAGE: "48120/900/51000/12000/300",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnCompleted = yield* Deferred.make<void>();
      const secondTurnCompleted = yield* Deferred.make<void>();
      let completedTurns = 0;
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            completedTurns += 1;
          }
          return completedTurns;
        }).pipe(
          Effect.flatMap((seen) =>
            event.type !== "turn.completed"
              ? Effect.void
              : seen === 1
                ? Deferred.succeed(firstTurnCompleted, undefined)
                : Deferred.succeed(secondTurnCompleted, undefined),
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });

      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });
      yield* Deferred.await(firstTurnCompleted);
      yield* adapter.sendTurn({ threadId, input: "again", attachments: [] });
      yield* Deferred.await(secondTurnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usages = runtimeEvents.filter((event) => event.type === "thread.token-usage.updated");
      assert.isAtLeast(usages.length, 3);

      // usage_update alone knows nothing about totals.
      assert.equal(usages[0]?.payload.usage.usedTokens, 48_120);
      assert.isUndefined(usages[0]?.payload.usage.totalProcessedTokens);

      // The prompt response contributes the totals and the breakdown while the
      // window reading from usage_update survives.
      const afterPrompt = usages[1]?.payload.usage;
      assert.deepStrictEqual(afterPrompt, {
        usedTokens: 48_120,
        totalProcessedTokens: 51_000,
        maxTokens: 200_000,
        inputTokens: 48_120,
        cachedInputTokens: 12_000,
        outputTokens: 900,
        reasoningOutputTokens: 300,
        compactsAutomatically: true,
      });

      // The next turn's usage_update carries no total, and must not erase one.
      assert.equal(usages[2]?.payload.usage.totalProcessedTokens, 51_000);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("omits totalProcessedTokens when the turn total does not exceed the window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-usage-small-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "48120/200000",
          T3_ACP_EMIT_PROMPT_USAGE: "30000/900/40000",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "openai/gpt-5" },
      });
      yield* adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usages = runtimeEvents.filter((event) => event.type === "thread.token-usage.updated");
      assert.isAtLeast(usages.length, 2);
      for (const usage of usages) {
        assert.isUndefined(usage.payload.usage.totalProcessedTokens);
      }
      // The breakdown still lands even when the total is not worth showing.
      assert.equal(usages.at(-1)?.payload.usage.outputTokens, 900);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("opens an approval request and answers with the agent-supplied option id", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "hermes-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "hermes-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels a silent turn and stays ready for the follow-up", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-cancel-silent-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({ threadId, input: "hang forever", attachments: [] });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({ threadId, input: "continue after stop", attachments: [] });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompleted = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompleted, 1);
      assert.equal(followUpCompleted[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("resumes through session/load and drops the replayed history", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({ threadId, input: "after resume", attachments: [] });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("restores a Hermes session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "fail prompt", attachments: [] }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a startSession routed to another provider", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("hermes-provider-mismatch"),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-empty-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "   ", attachments: [] }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. Every other test here calls startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("hermes"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello hermes", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});
