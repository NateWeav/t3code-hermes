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
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const HERMES_TERMINAL_RESULT_HEADINGS = new Set(["terminal result", "✅ terminal completed"]);
const HERMES_RESULT_FIELD = /^- \*\*[\w-]+:\*\*/;
const HERMES_OUTPUT_FIELD = "- **output:**";
const HERMES_EXIT_CODE_FIELD = /^- \*\*exit_code:\*\* (-?\d+)$/;

/**
 * Hermes's `terminal` tool sends a markdown summary instead of `rawOutput`, so client previews
 * would read "terminal result". Move the output into `rawOutput.stdout` and drop the summary; other
 * text passes through.
 */
export function normalizeHermesTerminalResult(toolCall: AcpToolCallState): AcpToolCallState {
  if (
    toolCall.kind !== "execute" ||
    (toolCall.status !== "completed" && toolCall.status !== "failed") ||
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

export const makeHermesAcpRuntime = Effect.fn("HermesAcpSupport.makeHermesAcpRuntime")(function* (
  input: HermesAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
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
