// @effect-diagnostics nodeBuiltinImport:off - Resolves the benchmark home and Hermes version once at startup.
/**
 * Records a Hermes ACP replay transcript through the real orchestrator and HermesAdapterV2 against
 * a benchmark Hermes home (evals/provider-parity/README.md), e.g. from apps/server:
 *   node scripts/record-hermes-acp-replay-fixture.ts --hermes-home ~/.hermes-bench --scenario simple
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HermesSettings, type ProviderReplayEntry } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  hermesSpawnEnvironment,
  makeHermesAdapterV2,
} from "../src/orchestration-v2/Adapters/HermesAdapterV2.ts";
import { HERMES_PROVIDER } from "../src/orchestration-v2/Adapters/HermesAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import {
  HERMES_MODEL_SELECTION,
  materializeFixtureInput,
  TOOL_CALL_READ_ONLY_WORKSPACE_ROOT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeHermesAcpRuntime } from "../src/provider/acp/HermesAcpSupport.ts";
import {
  checkLiveOutput,
  makeParityLiveTimer,
  parityAssertions,
  parityReportPath,
  writeParityLiveReport,
} from "./parityLiveReport.ts";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const HOME_PLACEHOLDER = "/home/hermes-replay";
const HERMES_HOME_PLACEHOLDER = `${HOME_PLACEHOLDER}/.hermes-bench`;

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

type WireMessage =
  | { readonly direction: "incoming" | "outgoing"; readonly message: JsonRpcMessage }
  /** One ACP process ended and the adapter spawned the next (an idle release or a reopen). */
  | { readonly direction: "respawn" };

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

/** The benchmark home: explicit, and never the real `~/.hermes` profile. */
function resolveBenchHermesHome(): string {
  const raw = readArgValues("--hermes-home")[0] ?? process.env.T3_HERMES_BENCH_HOME;
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("Pass --hermes-home <benchmark HERMES_HOME> (or set T3_HERMES_BENCH_HOME).");
  }
  const home = NodePath.resolve(raw.replace(/^~(?=$|\/)/u, NodeOS.homedir()));
  const realRoot = NodePath.resolve(NodeOS.homedir(), ".hermes");
  if (home === realRoot || home.startsWith(`${realRoot}/`)) {
    throw new Error(`Refusing to record against ${home}: use a standalone benchmark home.`);
  }
  return home;
}

/** Drops the agent harness's own model routing so the benchmark home's config decides. */
function benchEnvironment(hermesHome: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_") && key !== "CLAUDECODE",
      ),
    ),
    HERMES_HOME: hermesHome,
  };
}

function hermesVersion(binary: string, environment: NodeJS.ProcessEnv): string {
  try {
    return NodeChildProcess.execFileSync(binary, ["--version"], {
      env: environment,
      encoding: "utf8",
    })
      .split("\n")[0]!
      .trim();
  } catch {
    return "unknown";
  }
}

/** Tees raw ACP lines in wire order; a later process is marked as a respawn. */
function makeWireTee() {
  const wire: Array<WireMessage> = [];
  let runtimeCount = 0;
  const attachRuntime = () => {
    runtimeCount += 1;
    if (runtimeCount > 1) wire.push({ direction: "respawn" });
    let incomingBuffer = "";
    const push = (direction: "incoming" | "outgoing", line: string) => {
      if (line.trim().length === 0) return;
      wire.push({ direction, message: decodeJson(line) as JsonRpcMessage });
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  // A turn settles through its session/prompt response; done once each has been answered.
  const hasPendingPrompt = () => {
    const pending = new Set<string>();
    for (const wireMessage of wire) {
      if (wireMessage.direction === "respawn") {
        pending.clear();
        continue;
      }
      const { direction, message } = wireMessage;
      if (direction === "outgoing" && message.method === "session/prompt") {
        pending.add(String(message.id));
      } else if (direction === "incoming" && message.method === undefined) {
        pending.delete(String(message.id));
      }
    }
    return pending.size > 0;
  };
  return { wire, attachRuntime, hasPendingPrompt };
}

function frameLabel(kind: string, method: string, params: unknown): string {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : "";
  return `${kind}:${method}${updateType}`;
}

/**
 * Pairs JSON-RPC ids with their methods and emits the logical frames acp-replay-agent reads. The
 * first update after a prompt settles, with none open, is labeled `notification:session/update:
 * unprompted-<n>` so replay can hold a gateway turn (a background wake) until the run settles.
 */
function wireToEntries(wire: ReadonlyArray<WireMessage>): {
  readonly entries: Array<ProviderReplayEntry>;
  readonly droppedFrames: number;
} {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  let droppedFrames = 0;
  let promptSettled = false;
  let unprompted = 0;
  for (const wireMessage of wire) {
    if (wireMessage.direction === "respawn") {
      t3Requests.clear();
      agentRequests.clear();
      promptSettled = false;
      entries.push({ type: "runtime_exit", status: "success" });
      continue;
    }
    const { direction, message } = wireMessage;
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
        if (message.method === "session/prompt") promptSettled = false;
      }
      const kind = isRequest ? "request" : "notification";
      const opensUnpromptedTurn =
        promptSettled &&
        direction === "incoming" &&
        message.method === "session/update" &&
        ![...t3Requests.values()].includes("session/prompt");
      if (opensUnpromptedTurn) {
        promptSettled = false;
        unprompted += 1;
      }
      entries.push({
        type,
        label: opensUnpromptedTurn
          ? `notification:session/update:unprompted-${unprompted}`
          : frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) {
      droppedFrames += 1;
      continue;
    }
    pending.delete(String(message.id));
    if (method === "session/prompt") promptSettled = true;
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return { entries, droppedFrames };
}

const T3_INSTRUCTIONS_BODY = /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u;
const PULL_REQUEST_LINKING_BODY = /<pull_request_linking>\n[\s\S]*?\n<\/pull_request_linking>/u;

/** Replaces T3-owned request content so prompt wording changes do not invalidate recordings. */
function normalizeOutboundFrame(frame: Record<string, unknown>, runtimeInstructions: string) {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  switch (frame.method) {
    case "initialize":
      return {
        ...frame,
        params: Object.fromEntries(
          Object.keys(params).map((key) => [
            key,
            key === "protocolVersion" || key === "clientCapabilities" || key === "_meta"
              ? params[key]
              : "<any>",
          ]),
        ),
      };
    case "session/new":
    case "session/load":
    case "session/resume":
      return { ...frame, params: { ...params, mcpServers: "<any>" } };
    case "session/prompt": {
      if (!Array.isArray(params.prompt)) return frame;
      const prompt = params.prompt.filter(
        (part) => !(isRecord(part) && part.type === "text" && part.text === runtimeInstructions),
      );
      return {
        ...frame,
        params: {
          ...params,
          prompt: prompt.map((part) =>
            isRecord(part) && typeof part.text === "string"
              ? {
                  ...part,
                  text: part.text
                    .replace(
                      T3_INSTRUCTIONS_BODY,
                      "<t3_code_instructions>\n<any>\n</t3_code_instructions>",
                    )
                    .replace(
                      PULL_REQUEST_LINKING_BODY,
                      "<pull_request_linking>\n<any>\n</pull_request_linking>",
                    ),
                }
              : part,
          ),
        },
      };
    }
    default:
      return frame;
  }
}

const OTHER_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
// Endpoint hosts in model metadata name the recording machine's network.
const PRIVATE_URL = /\bhttps?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/gu;

function collectSessionIds(entries: ReadonlyArray<ProviderReplayEntry>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  };
  for (const entry of entries) {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) continue;
    const frame = entry.frame;
    if (frame.kind === "response" && frame.method === "session/new" && isRecord(frame.result)) {
      add(frame.result.sessionId);
    }
    if (entry.type === "emit_inbound" && isRecord(frame.params)) add(frame.params.sessionId);
  }
  return ids;
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly home: string;
  readonly hermesHome: string;
  readonly user: string;
  readonly runtimeInstructions: string;
}): Array<ProviderReplayEntry> {
  const sessionIds = collectSessionIds(input.entries);
  const paths: ReadonlyArray<readonly [string, string]> = [
    [input.workspace, "<workspace>"],
    [input.hermesHome, HERMES_HOME_PLACEHOLDER],
    [input.home, HOME_PLACEHOLDER],
  ];
  const replacements: Array<readonly [string, string]> = [
    ...sessionIds.map(
      (id, index) =>
        [id, `sess_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    // A HOME of "/" (root) or "" would replace every slash, method names included.
    ...paths.flatMap(([path, placeholder]) =>
      path.length <= 1
        ? []
        : [
            [encodeURIComponent(path), encodeURIComponent(placeholder)] as const,
            [path, placeholder] as const,
          ],
    ),
  ];
  const otherIds: Array<string> = [];
  const numberOtherIds = (text: string) =>
    text.replace(OTHER_UUID, (id) => {
      if (id.startsWith("00000000-0000-4000-8000-")) return id;
      if (!otherIds.includes(id)) otherIds.push(id);
      return `00000000-0000-4000-9000-${String(otherIds.indexOf(id) + 1).padStart(12, "0")}`;
    });
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const replaceAll = (text: string) => {
    const replaced = replacements
      .reduce(
        (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
        text,
      )
      .replace(PRIVATE_URL, "http://model-endpoint.invalid");
    const named =
      userPattern === undefined ? replaced : replaced.replace(userPattern, "hermes-replay");
    return numberOtherIds(named);
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutboundFrame(entry.frame, input.runtimeInstructions)
        : entry.frame;
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: replaceAll(entry.label) }),
      frame: mapStrings(frame, replaceAll),
    };
  });
}

const settings = Schema.decodeSync(HermesSettings)({
  enabled: true,
  binaryPath: process.env.T3_HERMES_BIN ?? "hermes",
});

const recordScenario = Effect.fn("recordHermesScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  if (fixture === undefined) {
    return yield* Effect.die(new Error(`No replay fixture named '${fixtureName}'.`));
  }
  const assertions = parityAssertions(fixture, HERMES_PROVIDER);
  const ownVariant = fixture.providers.find((provider) => provider.driver === HERMES_PROVIDER);
  // A scenario Hermes has no variant for yet borrows the reference variant's run settings.
  const settingsVariant =
    ownVariant ?? fixture.providers.find((provider) => provider.driver === assertions[0]?.owner);
  if (settingsVariant === undefined) {
    return yield* Effect.die(new Error(`'${fixtureName}' has no Hermes or reference variant.`));
  }
  const modelSelection = ownVariant?.modelSelection ?? HERMES_MODEL_SELECTION;
  const reportPath = parityReportPath();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hermesHome = resolveBenchHermesHome();
  const environment = benchEnvironment(hermesHome);
  const fixtureInput = fixture.buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  // The files these prompts read, as the Claude recorder seeds them.
  const seedDir =
    fixtureName === "tool_call_read_only"
      ? TOOL_CALL_READ_ONLY_WORKSPACE_ROOT
      : fixtureName === "subagent"
        ? realWorkspace
        : undefined;
  if (seedDir !== undefined) {
    yield* fs.makeDirectory(seedDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(seedDir, "package.json"),
      encodeJson({
        name: "claude-read-only-fixture",
        private: true,
        scripts: { typecheck: "tsc --noEmit" },
      }),
    );
    yield* fs.writeFileString(
      path.join(seedDir, "tsconfig.json"),
      encodeJson({ compilerOptions: { module: "ESNext", strict: true, target: "ES2022" } }),
    );
  }
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: HERMES_PROVIDER,
    modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/hermes-record`,
    commands: materialized.commands,
    // Replay gates and held runs pace replay on the test clock; live, Hermes and wall time pace
    // themselves. The clock steps stay: they order background dispatches as replay does.
    steps: materialized.steps.flatMap((step) =>
      step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting"
        ? []
        : [step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step],
    ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...settingsVariant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const timer = makeParityLiveTimer();
  // Provider threads whose roster still lists background work that will wake Hermes.
  const backgroundRosters = new Set<string>();
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const adapter = yield* makeHermesAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment,
        childProcessSpawner,
        selfInvocation: yield* resolveSelfInvocation(),
        // Without it the adapter drops the gateway's own turns (background wakes) as production
        // never would.
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        // Production's runtime factory, with the protocol logger teeing raw lines.
        makeRuntime: ({ runtimePolicy, processEnvironment, ...input }) =>
          makeHermesAcpRuntime({
            ...input,
            protocolLogging: tee.attachRuntime(),
            hermesSettings: settings,
            environment: hermesSpawnEnvironment(
              environment,
              runtimePolicy.runtimeMode,
              processEnvironment,
            ),
            childProcessSpawner,
          }),
      });
      // The scenario runs on the replay TestClock so its clock steps order dispatches as replay
      // will. Hermes itself runs on wall time, so the adapter's session does too.
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        timer.wrapAdapter({
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
                ...session,
                events: session.events.pipe(
                  Stream.tap((event) =>
                    Effect.sync(() => {
                      if (event.type !== "provider_thread.updated") return;
                      const tasks = event.providerThread.pendingBackgroundTasks ?? [];
                      if (tasks.length > 0) backgroundRosters.add(event.providerThread.id);
                      else backgroundRosters.delete(event.providerThread.id);
                    }),
                  ),
                ),
                startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                respondToRuntimeRequest: (turnInput) =>
                  onWallClock(session.respondToRuntimeRequest(turnInput)),
              })),
              onWallClock,
            ),
        }),
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
        NodeServices.layer,
        NodeCrypto.layer,
        IdAllocator.layer,
      ),
    ),
  );

  // The session stays open until every prompt is answered, no background work that will wake
  // Hermes is pending, and Hermes has been quiet for a few seconds, so the transcript holds
  // everything replay emits, gateway follow-up turns included.
  let quietPolls = 0;
  let seenFrames = -1;
  const waitForHermesIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.sync(() => {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        return quietPolls >= 3 && !tee.hasPendingPrompt() && backgroundRosters.size === 0;
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("5 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const exit = yield* runOrchestratorV2Scenario(scenario, { afterSteps: waitForHermesIdle }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        scenario,
        layerRegistry,
        settingsVariant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
    Effect.exit,
  );

  const { entries, droppedFrames } = wireToEntries(tee.wire);
  const closedCleanly = entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      isRecord(entry.frame) &&
      entry.frame.method === "session/close",
  );
  const transcript = {
    provider: HERMES_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-hermes-recorder",
      hermesVersion: hermesVersion(settings.binaryPath, environment),
      normalization:
        "Session ids are fixed sess_ UUIDs and other UUIDs are numbered in first-seen order, the workspace is <workspace>, HOME is /home/hermes-replay, the benchmark HERMES_HOME is /home/hermes-replay/.hermes-bench, the recording user is hermes-replay and IPv4 endpoint URLs are http://model-endpoint.invalid. T3-owned prompt text, MCP servers and initialize params other than clientCapabilities and _meta are <any>. Timestamps are kept as recorded.",
      droppedFrames,
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspace: realWorkspace,
        home: process.env.HOME ?? "",
        hermesHome,
        user: process.env.USER ?? "",
        runtimeInstructions: buildRuntimeInstructions({
          harness: "Hermes",
          model: modelSelection.model,
        }),
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  // The live orchestration must already satisfy the fixture's assertions before anything is
  // written, so a changed Hermes response can never replace a good fixture with one that fails
  // replay. `--force` writes it anyway to inspect the frames.
  const check = Exit.isSuccess(exit)
    ? checkLiveOutput(assertions, exit.value, transcript)
    : { passedOwner: null, failure: new Error(`Scenario did not complete: ${String(exit.cause)}`) };
  if (reportPath !== undefined) {
    writeParityLiveReport(
      reportPath,
      timer.report({
        driver: HERMES_PROVIDER,
        scenario: fixtureName,
        model: modelSelection.model,
        assertion: check.passedOwner,
        failure: check.failure,
        result: Exit.isSuccess(exit) ? exit.value : undefined,
      }),
    );
    yield* Console.log(
      `${fixtureName}: ${check.failure === undefined ? `passed (${check.passedOwner} assertion)` : "failed"}; report at ${reportPath}`,
    );
  } else if (check.failure !== undefined && !process.argv.includes("--force")) {
    return yield* Effect.die(
      new Error(`Live orchestration failed ${fixtureName} assertions; nothing was written.`, {
        cause: check.failure,
      }),
    );
  }

  const explicitOut = readArgValues("--out")[0];
  if (reportPath !== undefined && explicitOut === undefined) return;
  const outputPath =
    explicitOut ??
    (yield* path.fromFileUrl(
      ownVariant?.transcriptFile ??
        new URL(
          `../src/orchestration-v2/testkit/fixtures/${fixtureName}/hermes_transcript.ndjson`,
          import.meta.url,
        ),
    ));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(
    `Wrote ${transcriptEntries.length} Hermes ACP replay entries to ${outputPath}` +
      (ownVariant === undefined && check.passedOwner !== null
        ? ` (passed the ${check.passedOwner} assertion; add a hermes variant using it)`
        : ""),
  );
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}
if (scenarios.length > 1 && (readArgValues("--out").length > 0 || parityReportPath())) {
  throw new Error("--out and --report take one scenario; run them separately.");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
