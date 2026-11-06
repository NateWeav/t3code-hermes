/**
 * Spawn, model, and mode helpers for `hermes acp`. Hermes reads credentials from its own
 * `HERMES_HOME`, so `authenticate` is a constant.
 */
import {
  type HermesSettings,
  type ProviderApprovalOption,
  type OrchestrationV2ProviderFailure,
  ProviderDriverKind,
  type RuntimeMode,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import type {
  AcpSessionModeState,
  AcpToolCallState,
} from "@t3tools/provider-acp/server/runtimeModel";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { unknownRecord } from "@t3tools/provider-acp/server/clientPolicy";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
/** Hermes authenticates from `~/.hermes/.env`; the method id is a formality. */
const HERMES_AUTH_METHOD_ID = "hermes";
export const HERMES_FALLBACK_MODEL_ID = "hermes-4";

/**
 * Mode ids Hermes derives from its edit-approval policy (`default`, `accept_edits`, `dont_ask`).
 * Matching is by id, name, then substring, so builds that rename a policy still resolve. Order is
 * preference: `dont_ask` auto-allows every edit, while `accept_edits` still asks outside the
 * workspace.
 */
const HERMES_AUTONOMOUS_MODE_ALIASES = [
  "dont_ask",
  "don't ask",
  "auto",
  "autonomous",
  "auto approve",
  "yolo",
  "full access",
  "accept edits",
  "bypass",
];
const HERMES_ACCEPT_EDITS_MODE_ALIASES = [
  "accept_edits",
  "accept edits",
  ...HERMES_AUTONOMOUS_MODE_ALIASES,
];
const HERMES_APPROVAL_MODE_ALIASES = ["ask", "approve", "manual", "confirm", "default"];

/**
 * Slash commands the Hermes ACP adapter handles, mirroring `_ADVERTISED_COMMANDS` in
 * `acp_adapter/server.py` (not the TUI's set). Seeds the composer before
 * `available_commands_update` lands.
 */
export const HERMES_BUILT_IN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "help", description: "List available commands" },
  {
    name: "model",
    description: "Show current model and provider, or switch models",
    input: { hint: "model name to switch to" },
  },
  { name: "tools", description: "List available tools with descriptions" },
  { name: "context", description: "Show conversation message counts by role" },
  { name: "reset", description: "Clear conversation history" },
  { name: "compress", description: "Compress conversation context" },
  {
    name: "steer",
    description: "Inject guidance into the currently running agent turn",
    input: { hint: "guidance for the active turn" },
  },
  {
    name: "queue",
    description: "Queue a prompt to run after the current turn finishes",
    input: { hint: "prompt to run next" },
  },
  { name: "version", description: "Show Hermes version" },
];

/**
 * Hermes skill and memory tools keep their name only in the agent's title
 * (`skill view (name)`, `memory add: user`); the shared presentation flattens
 * read and edit kinds into "Read file" or "Changed files". Clients label the
 * fork's skill and memory work-log rows from the turn item title.
 */
const HERMES_AGENT_ACTIVITY_TITLE = /^(?:skills?[ _]|memory )/i;

export function preserveHermesAgentActivityTitle(toolCall: AcpToolCallState): AcpToolCallState {
  const title = typeof toolCall.data.title === "string" ? toolCall.data.title.trim() : "";
  return title && HERMES_AGENT_ACTIVITY_TITLE.test(title) && toolCall.title !== title
    ? { ...toolCall, title }
    : toolCall;
}

/**
 * Hermes's gateway renames an editor's MCP server to `editor_<name>_<8 hex>`, or
 * `editor_<20 hex>_<index>` in sessions frozen before Hermes d28c07b3f2. T3 injects only its own
 * server, so either form is T3's.
 */
const HERMES_EDITOR_T3_SERVER_PREFIX = /^mcp__editor_(?:t3_code_[0-9a-f]{8}|[0-9a-f]{20}_0)__/;

/**
 * Restores the `mcp__t3_code__` prefix T3 recognizes its tools by. Hermes reports a tool only
 * once it runs and never sends `in_progress`, so a T3 call (a blocking wait included) is marked
 * running rather than pending.
 */
export function normalizeHermesT3McpToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  const title = typeof toolCall.data.title === "string" ? toolCall.data.title : undefined;
  if (title === undefined || !HERMES_EDITOR_T3_SERVER_PREFIX.test(title)) return toolCall;
  const t3Title = title.replace(HERMES_EDITOR_T3_SERVER_PREFIX, "mcp__t3_code__");
  return {
    ...toolCall,
    ...(toolCall.title === undefined ? {} : { title: t3Title }),
    ...(toolCall.status === "pending" ? { status: "inProgress" as const } : {}),
    data: { ...toolCall.data, title: t3Title },
  };
}

const HERMES_TERMINAL_RESULT_HEADINGS = new Set(["terminal result", "✅ terminal completed"]);
const HERMES_RESULT_FIELD = /^- \*\*[\w-]+:\*\*/;
const HERMES_OUTPUT_FIELD = "- **output:**";
const HERMES_EXIT_CODE_FIELD = /^- \*\*exit_code:\*\* (-?\d+)$/;

/**
 * Hermes's `terminal` tool sends a markdown summary instead of `rawOutput`, so client previews
 * would read "terminal result". Move the output into `rawOutput.stdout` and drop the summary; other
 * text passes through. A running call's only content is Hermes's `$ <command>` echo of its input,
 * which would read as output; it is dropped too.
 */
export function normalizeHermesTerminalResult(toolCall: AcpToolCallState): AcpToolCallState {
  if (
    toolCall.kind !== "execute" ||
    toolCall.data.rawOutput !== undefined ||
    !Array.isArray(toolCall.data.content) ||
    toolCall.data.content.length !== 1
  ) {
    return toolCall;
  }
  const entry = toolCall.data.content[0] as EffectAcpSchema.ToolCallContent;
  if (entry.type !== "content" || entry.content.type !== "text") {
    return toolCall;
  }
  if (toolCall.status !== "completed" && toolCall.status !== "failed") {
    if (!entry.content.text.startsWith("$ ")) return toolCall;
    const { content: _echo, ...data } = toolCall.data;
    return { ...toolCall, data };
  }
  const [heading = "", ...lines] = entry.content.text.split("\n");
  if (!HERMES_TERMINAL_RESULT_HEADINGS.has(heading.trim())) {
    return toolCall;
  }

  // Hermes writes `output`, then `exit_code`, then optional fields such as
  // `cwd` or `hint`. The output can itself contain lines shaped like fields,
  // so it runs to the last exit-code line rather than the next field.
  const exitCodeIndex = lines.findLastIndex((line) => HERMES_EXIT_CODE_FIELD.test(line));
  const exitCodeMatch =
    exitCodeIndex === -1 ? null : HERMES_EXIT_CODE_FIELD.exec(lines[exitCodeIndex]!);
  const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : undefined;
  const outputIndex = lines.findIndex((line) => line.startsWith(HERMES_OUTPUT_FIELD));
  let stdout: string | undefined;
  if (outputIndex !== -1) {
    const nextFieldIndex = lines.findIndex(
      (line, index) => index > outputIndex && HERMES_RESULT_FIELD.test(line),
    );
    const outputEnd =
      exitCodeIndex > outputIndex
        ? exitCodeIndex
        : nextFieldIndex === -1
          ? lines.length
          : nextFieldIndex;
    stdout = [
      lines[outputIndex]!.slice(HERMES_OUTPUT_FIELD.length),
      ...lines.slice(outputIndex + 1, outputEnd),
    ]
      .join("\n")
      .trim();
  }

  const { content: _summary, ...data } = toolCall.data;
  return {
    ...toolCall,
    data: {
      ...data,
      rawOutput: {
        ...(stdout ? { stdout } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
    },
  };
}

const HERMES_WEB_SEARCH_START = "Searching the web for: ";

/**
 * Hermes sends `web_search` without `rawInput`, so its card had no query. The start text carries
 * the whole query (the title cuts it at 80 characters); later updates keep it as `rawInput`.
 */
export function normalizeHermesWebSearchQuery(toolCall: AcpToolCallState): AcpToolCallState {
  const content = toolCall.data.content;
  if (toolCall.kind !== "fetch" || toolCall.data.rawInput !== undefined) return toolCall;
  if (!Array.isArray(content) || content.length !== 1) return toolCall;
  const entry = content[0] as EffectAcpSchema.ToolCallContent;
  if (entry.type !== "content" || entry.content.type !== "text") return toolCall;
  const text = entry.content.text;
  if (!text.startsWith(HERMES_WEB_SEARCH_START)) return toolCall;
  const query = text.slice(HERMES_WEB_SEARCH_START.length).trim();
  return query.length === 0
    ? toolCall
    : { ...toolCall, data: { ...toolCall.data, rawInput: { query } } };
}

/** Hermes's permission cards; no tool call shares these ids. */
const HERMES_PERMISSION_CARD_ID = /^(?:edit-approval|perm-check)-\d+$/;
const HERMES_EDIT_DIFFS_KEPT = 64;

/**
 * Hermes's gateway sends an edit's diff only on its approval request (`edit-approval-N`); the
 * write's own card reads "Preparing write…" and then "✅ write_file completed…". This carries the
 * approved diff onto that card, and drops the status update closing the approval card, which T3
 * already shows as the resolved approval.
 */
export function makeHermesEditApprovalCards() {
  const pendingByPath = new Map<string, EffectAcpSchema.ToolCallContent>();
  const byToolCallId = new Map<string, EffectAcpSchema.ToolCallContent>();
  const keep = (
    map: Map<string, EffectAcpSchema.ToolCallContent>,
    key: string,
    diff: EffectAcpSchema.ToolCallContent,
  ) => {
    map.delete(key);
    map.set(key, diff);
    if (map.size > HERMES_EDIT_DIFFS_KEPT) map.delete(map.keys().next().value!);
  };
  return {
    onPermissionRequest: (request: EffectAcpSchema.RequestPermissionRequest) => {
      const toolCall = request.toolCall;
      if (toolCall.kind !== "edit" || !HERMES_PERMISSION_CARD_ID.test(toolCall.toolCallId)) return;
      const diffs = (toolCall.content ?? []).filter((entry) => entry.type === "diff");
      const diff = diffs.length === 1 ? diffs[0]! : undefined;
      if (diff?.type !== "diff" || !("path" in diff)) return;
      // `locations` carry the path as the model wrote it; the diff carries it resolved.
      const requestedPath = unknownRecord(unknownRecord(toolCall.rawInput)?.arguments)?.path;
      for (const path of new Set([diff.path, requestedPath])) {
        if (typeof path === "string" && path.length > 0) keep(pendingByPath, path, diff);
      }
    },
    normalizeToolCall: (toolCall: AcpToolCallState): AcpToolCallState => {
      if (toolCall.kind !== "edit") return toolCall;
      let diff = byToolCallId.get(toolCall.toolCallId);
      if (diff === undefined && (toolCall.status === "completed" || toolCall.status === "failed")) {
        const locations = toolCall.data.locations;
        const path =
          Array.isArray(locations) && locations.length === 1
            ? unknownRecord(locations[0])?.path
            : undefined;
        diff = typeof path === "string" ? pendingByPath.get(path) : undefined;
        if (diff === undefined) return toolCall;
        for (const [key, pending] of pendingByPath) {
          if (pending === diff) pendingByPath.delete(key);
        }
        keep(byToolCallId, toolCall.toolCallId, diff);
      }
      // A denied or failed write keeps Hermes's reason; it wrote nothing.
      return diff === undefined || toolCall.status !== "completed"
        ? toolCall
        : { ...toolCall, data: { ...toolCall.data, content: [diff] } };
    },
    ignoreSessionUpdate: (notification: EffectAcpSchema.SessionNotification) =>
      notification.update.sessionUpdate === "tool_call_update" &&
      HERMES_PERMISSION_CARD_ID.test(notification.update.toolCallId),
  };
}

/**
 * Hermes's `clarify` arrives twice: as a tool call titled `clarify: <question>`, and as the
 * `elicitation/create` form T3 shows as the question. This drops the tool call's updates.
 */
export function makeHermesClarifyCallFilter() {
  const clarifyCalls = new Set<string>();
  return (notification: EffectAcpSchema.SessionNotification): boolean => {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return false;
    }
    const key = `${notification.sessionId}\n${update.toolCallId}`;
    const title = typeof update.title === "string" ? update.title : "";
    if (title === "clarify" || title.startsWith("clarify: ")) clarifyCalls.add(key);
    else if (!clarifyCalls.has(key)) return false;
    if (update.status === "completed" || update.status === "failed") clarifyCalls.delete(key);
    return true;
  };
}

/** The heading and first value of each `- **field:** value` line of a Hermes result summary. */
function hermesResultSummary(
  toolCall: AcpToolCallState,
): { readonly heading: string; readonly fields: ReadonlyMap<string, string> } | undefined {
  if (toolCall.status !== "completed" && toolCall.status !== "failed") return undefined;
  const content = toolCall.data.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const entry = content[0] as EffectAcpSchema.ToolCallContent;
  if (entry.type !== "content" || entry.content.type !== "text") return undefined;
  const [heading = "", ...lines] = entry.content.text.split("\n");
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^- \*\*([\w-]+):\*\* (.*)$/.exec(line);
    if (match !== null && !fields.has(match[1]!)) fields.set(match[1]!, match[2]!);
  }
  return { heading: heading.trim(), fields };
}

// `process_manage` statuses after which the process sends no completion wake.
const HERMES_PROCESS_ENDED_STATUSES = new Set([
  "exited",
  "killed",
  "already_exited",
  "not_found",
  "handed_off",
]);

/** Hermes accepts a full `proc_…` id, or any unique prefix with or without `proc_`. */
function resolveHermesProcessId(
  reference: string,
  runningTaskIds: ReadonlySet<string>,
): string | undefined {
  if (runningTaskIds.has(reference)) return reference;
  const prefix = reference.startsWith("proc_") ? reference : `proc_${reference}`;
  const matches = [...runningTaskIds].filter((taskId) => taskId.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Background processes `t3_background_wait` can hold a Hermes thread on. The gateway reports no
 * process lifecycle to ACP viewers, so they are read from the agent's own results: a background
 * `terminal` start Hermes armed a completion wake for, keyed by the `proc_…` id its result gives
 * the agent, and a `process_manage` result that saw one end.
 */
export function extractHermesAwaitableBackgroundTasks(
  toolCall: AcpToolCallState,
  runningTaskIds: ReadonlySet<string>,
): ReadonlyArray<{
  readonly taskId: string;
  readonly status: "running" | "ended";
  readonly description?: string;
}> {
  const summary = hermesResultSummary(toolCall);
  if (summary === undefined) return [];
  const sessionId = summary.fields.get("session_id");
  if (HERMES_TERMINAL_RESULT_HEADINGS.has(summary.heading)) {
    // Without a wake nothing would release a hold, so only notifying processes are awaitable.
    if (!sessionId?.startsWith("proc_") || summary.fields.get("notify_on_complete") !== "True") {
      return [];
    }
    return [
      {
        taskId: sessionId,
        status: "running",
        ...(toolCall.command === undefined ? {} : { description: toolCall.command }),
      },
    ];
  }
  if (summary.heading !== "process_manage result") return [];
  const status = summary.fields.get("status");
  if (status === undefined || !HERMES_PROCESS_ENDED_STATUSES.has(status)) return [];
  // `wait` results omit the id; the call's own arguments carry it.
  const rawInput = toolCall.data.rawInput;
  const argument =
    typeof rawInput === "object" && rawInput !== null ? Reflect.get(rawInput, "session_id") : null;
  const reference = typeof argument === "string" ? argument : sessionId;
  const taskId =
    reference === undefined ? undefined : resolveHermesProcessId(reference, runningTaskIds);
  return taskId === undefined ? [] : [{ taskId, status: "ended" }];
}

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * `probe` launches outside a per-agent systemd scope: `session/new` may start the shared
   * Hermes gateway (setsid, idle-exit), and stopping a probe's scope would kill it mid-boot.
   */
  readonly launch?: "session" | "probe";
  /** Reports each ACP request as it starts, e.g. `initialize` then `session/new`. */
  readonly onRequestStarted?: (method: string) => Effect.Effect<void>;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

const HERMES_SESSION_LOAD_REPLAY_IDLE_GAP = "90 seconds";

export const makeHermesAcpRuntime = Effect.fn("HermesAcpSupport.makeHermesAcpRuntime")(function* (
  input: HermesAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  SecureRandom.SecureRandom | Scope.Scope
> {
  const { launch, onRequestStarted, ...runtimeInput } = input;
  const requestLogger =
    onRequestStarted === undefined
      ? input.requestLogger
      : (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
          Effect.andThen(
            event.status === "started" ? onRequestStarted(event.method) : Effect.void,
            input.requestLogger?.(event) ?? Effect.void,
          );
  const build = Layer.build(
    AcpSessionRuntime.layer({
      // Hermes always answers `session/load`, often seconds after replaying history. Treating a
      // quiet replay as loaded would send `set_model` and the rollback rewind before the load.
      sessionLoadReplayIdleGap: HERMES_SESSION_LOAD_REPLAY_IDLE_GAP,
      ...runtimeInput,
      ...(requestLogger === undefined ? {} : { requestLogger }),
      spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
      authMethodId: HERMES_AUTH_METHOD_ID,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  const acpContext = yield* launch === "probe"
    ? build.pipe(Effect.provideService(AgentScope, AgentScope.defaultValue()))
    : build;
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : HERMES_FALLBACK_MODEL_ID;
  return normalizeModelSlug(base, HERMES_DRIVER_KIND) ?? HERMES_FALLBACK_MODEL_ID;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  /**
   * Re-send `session/set_model` even when unchanged: Hermes rebuilds the agent from `config.yaml`,
   * which is how reasoning effort reaches a running session. Session id and history survive.
   */
  readonly forceReapply?: boolean;
}): Effect.Effect<string | undefined, E> {
  // Hermes model ids are `provider:model`, so the bare placeholder is never one: asking for it
  // means "keep whatever the profile runs". A bare model naming the one already running (a
  // background run's thread records the bare model when its provider was a `custom` endpoint) is a
  // keep as well.
  const requestedModelId =
    input.requestedModelId === HERMES_FALLBACK_MODEL_ID ||
    (input.requestedModelId !== undefined &&
      !input.requestedModelId.includes(":") &&
      input.currentModelId?.endsWith(`:${input.requestedModelId}`))
      ? undefined
      : input.requestedModelId;
  const targetModelId = requestedModelId ?? input.currentModelId;
  const shouldSwitchModel =
    targetModelId !== undefined &&
    (targetModelId !== input.currentModelId || input.forceReapply === true);
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(targetModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(targetModelId));
}

function findModeIdByAliases(
  modes: ReadonlyArray<AcpSessionModeState["availableModes"][number]>,
  aliases: ReadonlyArray<string>,
): string | undefined {
  const searchText = (mode: (typeof modes)[number]) =>
    [mode.id, mode.name, mode.description]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();

  for (const alias of aliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) return exact.id;
  }
  for (const alias of aliases) {
    const partial = modes.find((mode) => searchText(mode).includes(alias));
    if (partial) return partial.id;
  }
  return undefined;
}

/**
 * Pick the Hermes session mode that matches the thread's runtime mode.
 * Returns `undefined` when the agent advertises no modes, or when the mode
 * it already runs is the best match — callers then skip `session/set_mode`.
 */
export function resolveHermesSessionModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState || modeState.availableModes.length === 0) {
    return undefined;
  }
  const aliases =
    input.runtimeMode === "approval-required"
      ? HERMES_APPROVAL_MODE_ALIASES
      : input.runtimeMode === "auto-accept-edits"
        ? HERMES_ACCEPT_EDITS_MODE_ALIASES
        : HERMES_AUTONOMOUS_MODE_ALIASES;
  const requestedModeId = findModeIdByAliases(modeState.availableModes, aliases);
  return requestedModeId === undefined || requestedModeId === modeState.currentModeId
    ? undefined
    : requestedModeId;
}

/**
 * The choices a Hermes permission request offers. Hermes drops "Allow for session" when the gate
 * re-asks every time (Smart-DENY overrides, protected writes). T3 answers `acceptForSession` with
 * the first `allow_always` option, so it is offered only when that one is Hermes's `allow_session`.
 */
export function hermesApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim() !== "");
  return [
    { decision: "cancel", label: "Cancel" },
    ...(has("reject_once") ? [{ decision: "decline", label: "Deny" } as const] : []),
    ...(request.options.find((option) => option.kind === "allow_always")?.optionId ===
    "allow_session"
      ? [{ decision: "acceptForSession", label: "Allow for this session" } as const]
      : []),
    ...(has("allow_once") ? [{ decision: "accept", label: "Allow once" } as const] : []),
  ];
}

/**
 * Hermes answers `/compress` with its manual-compression summary ("Compressed: 12 → 5 messages",
 * "Approx request size: ~41,200 → ~9,800 tokens"). A no-op, refused or aborted run removed nothing.
 */
export function readHermesCompressReply(text: string): {
  readonly compacted: boolean;
  readonly beforeTokenCount?: number;
  readonly afterTokenCount?: number;
} {
  if (/^(?:No changes from compression|Compression refused|Compression aborted)\b/mu.test(text)) {
    return { compacted: false };
  }
  const tokens = /^Approx request size: ~([\d,]+) → ~([\d,]+) tokens/mu.exec(text);
  const count = (value: string) => Number(value.replaceAll(",", ""));
  return tokens === null
    ? { compacted: true }
    : { compacted: true, beforeTokenCount: count(tokens[1]!), afterTokenCount: count(tokens[2]!) };
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** `hermes acp` answers a failed prompt with `Internal error` and puts its own reason in `data.details`. */
function hermesPromptErrorDetails(cause: unknown): string | undefined {
  if (!isAcpRequestError(cause)) return undefined;
  const details = (cause.data as { readonly details?: unknown } | null | undefined)?.details;
  return typeof details === "string" && details.trim() !== "" ? details.trim() : undefined;
}

/**
 * The gateway restarted or dropped the connection under a turn: Hermes fences that turn as
 * `unknown` and will not say how it ended. The attached `hermes acp` only re-reads the fence
 * after it has queued the next prompt behind it, so that process is replaced first.
 */
export function isHermesGatewayTurnLoss(cause: unknown): boolean {
  const details = hermesPromptErrorDetails(cause);
  return (
    details !== undefined &&
    (details.startsWith("Gateway disconnected;") ||
      details.startsWith("unknown_execution:") ||
      details === "session_replay_gap")
  );
}

export function hermesPromptFailure(cause: unknown): OrchestrationV2ProviderFailure {
  const details = hermesPromptErrorDetails(cause);
  return makeProviderFailure({
    cause,
    message: isHermesGatewayTurnLoss(cause)
      ? "The Hermes gateway restarted before this turn finished, so Hermes cannot tell whether it completed. The conversation is kept; send a message to continue."
      : details === undefined
        ? undefined
        : `Hermes: ${details}`,
    ...(isAcpRequestError(cause) ? { code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

const HERMES_DISCARD_COMMAND = /`\/discard ([^`\s]+)`/g;
const HERMES_DISCARD_REPLY = /^(?:Discarded the lost turn|No unknown \(lost\) admission)/;
/** Hermes's notice naming `/discard` when it re-attaches a session with a lost turn; T3 sends it. */
const HERMES_LOST_TURN_NOTICE = /^do not resend accepted input; a turn in this session was lost/;
const HERMES_TURN_OUTPUT = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

const HERMES_STOP_NOTICE =
  /^(?:Operation interrupted\b|Stopped (?:before this turn started|waiting for another Hermes process on this session)\. Your message was not processed\.$)/u;

/**
 * Hermes answers a Stop with a status line as reply text, which its gateway calls cancellation
 * metadata but filters only in part. T3 already shows the stop, so it drops them until the next prompt.
 */
export function hideHermesStopNotices(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  let stopped = false;
  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        return stopped &&
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text" &&
          HERMES_STOP_NOTICE.test(update.content.text.trim())
          ? Effect.void
          : handler(notification);
      }),
    prompt: (payload, options) =>
      Effect.suspend(() => {
        stopped = false;
        return runtime.prompt(payload, options);
      }),
    cancel: Effect.suspend(() => {
      stopped = true;
      return runtime.cancel;
    }),
  };
}

/** How Hermes refused a prompt because a turn lost in a gateway restart blocks the session. */
function lostTurnRefusal(
  cause: unknown,
): { readonly submitted: boolean; readonly lostAdmissionIds: ReadonlyArray<string> } | undefined {
  const details = hermesPromptErrorDetails(cause);
  if (!details?.startsWith("unknown_execution:")) return undefined;
  const lostAdmissionIds = Array.from(
    details.matchAll(HERMES_DISCARD_COMMAND),
    (match) => match[1]!,
  );
  if (lostAdmissionIds.length === 0) return undefined;
  if (details.includes("(nothing was submitted)")) return { submitted: false, lostAdmissionIds };
  if (details.includes("(your input is accepted and kept)"))
    return { submitted: true, lostAdmissionIds };
  return undefined;
}

// The gateway's turn is outside T3's clock; a TestClock sleep would wait for an advance that never comes.
const wallClock = Clock.Clock.defaultValue();
const HERMES_BUSY_RESENDS = 60;

/**
 * Hermes refuses `/compress` and other idle-only commands with `session_busy` while the gateway
 * finishes a turn of its own, such as a background job's wake, whose end ACP never reports. The
 * refusal admitted nothing, so the prompt is resent each `resendAfter` until that turn ends,
 * unless the turn was cancelled meanwhile.
 */
export function resendHermesPromptsRefusedBusy(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  resendAfter: Duration.Input = "1 second",
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  let cancels = 0;
  const send = (
    payload: Parameters<typeof runtime.prompt>[0],
    options: Parameters<typeof runtime.prompt>[1],
    cancelsAtSend: number,
    resends: number,
  ): ReturnType<typeof runtime.prompt> =>
    runtime.prompt(payload, options).pipe(
      Effect.catchIf(
        (error) =>
          resends > 0 &&
          cancels === cancelsAtSend &&
          hermesPromptErrorDetails(error) === "session_busy",
        (error) =>
          Effect.sleep(resendAfter).pipe(
            Effect.provideService(Clock.Clock, wallClock),
            Effect.andThen(
              Effect.suspend(() =>
                cancels === cancelsAtSend
                  ? send(payload, options, cancelsAtSend, resends - 1)
                  : Effect.fail(error),
              ),
            ),
          ),
      ),
    );
  return {
    ...runtime,
    cancel: Effect.suspend(() => {
      cancels += 1;
      return runtime.cancel;
    }),
    prompt: (payload, options) =>
      Effect.suspend(() => send(payload, options, cancels, HERMES_BUSY_RESENDS)),
  };
}

/**
 * A lost turn blocks its Hermes session until `/discard <admission>`; the user's next message is
 * that acknowledgement. Refused unsubmitted, the prompt is resent after the discard. Queued behind
 * the lost turn (Hermes without `acp-lost-turn-refusal`), the discard runs it, so it is never
 * resent. Output during the prompt means its own running turn was the one lost.
 */
export function discardLostHermesTurnsOnPrompt(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  let pendingDiscardReplies = 0;
  let promptOutput = false;
  const discard = (admissionIds: ReadonlyArray<string>) =>
    Effect.forEach(
      admissionIds,
      (admissionId) =>
        Effect.sync(() => {
          pendingDiscardReplies += 1;
        }).pipe(
          Effect.andThen(
            runtime.prompt({ prompt: [{ type: "text", text: `/discard ${admissionId}` }] }),
          ),
        ),
      { discard: true },
    );
  return {
    ...runtime,
    handleSessionUpdate: (handler) =>
      runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          if (HERMES_LOST_TURN_NOTICE.test(update.content.text)) return Effect.void;
          if (pendingDiscardReplies > 0 && HERMES_DISCARD_REPLY.test(update.content.text)) {
            pendingDiscardReplies -= 1;
            return Effect.void;
          }
        }
        if (HERMES_TURN_OUTPUT.has(update.sessionUpdate)) promptOutput = true;
        return handler(notification);
      }),
    prompt: (payload, options) =>
      Effect.sync(() => {
        promptOutput = false;
      }).pipe(
        Effect.andThen(runtime.prompt(payload, options)),
        Effect.catchIf(
          (error) => {
            const refusal = lostTurnRefusal(error);
            return refusal !== undefined && (!refusal.submitted || !promptOutput);
          },
          (error) => {
            const refusal = lostTurnRefusal(error)!;
            return discard(refusal.lostAdmissionIds).pipe(
              Effect.andThen(
                refusal.submitted
                  ? Effect.succeed({ stopReason: "end_turn" as const })
                  : runtime.prompt(payload, options),
              ),
            );
          },
        ),
      ),
  };
}

const HERMES_STEER_METHOD = "_hermes/steer";
const decodeHermesSteerCapability = Schema.decodeUnknownOption(
  Schema.Struct({ hermes: Schema.Struct({ steer: Schema.Literal(true) }) }),
);
const decodeHermesSteerResult = Schema.decodeUnknownOption(
  Schema.Struct({ steered: Schema.Boolean }),
);

/**
 * `hermes acp` with the `acp-active-steering` patch steers the running turn through
 * `_hermes/steer`: Hermes answers whether that turn took the text, and a turn reads every steer
 * it took before it ends, so there is no delivery report to wait for.
 */
export const hermesSteering = {
  supported: (
    initializeResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["initializeResult"],
  ) => Option.isSome(decodeHermesSteerCapability(initializeResult.agentCapabilities?._meta)),
  send: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    sessionId: string,
    text: string,
  ) =>
    runtime.request(HERMES_STEER_METHOD, { sessionId, text }).pipe(
      Effect.flatMap((result) =>
        Option.match(decodeHermesSteerResult(result), {
          onSome: ({ steered }) => Effect.succeed(steered ? {} : null),
          onNone: () =>
            Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: "Hermes did not say whether it took the steering message.",
                method: HERMES_STEER_METHOD,
                data: result,
              }),
            ),
        }),
      ),
    ),
};
