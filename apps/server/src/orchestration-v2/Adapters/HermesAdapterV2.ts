/**
 * Hermes Agent over ACP stdio (`hermes acp`) as a flavor of the shared ACP adapter. Differs by:
 * reasoning effort in `config.yaml`, delegations as one `delegate_task` call, and background
 * processes read from the agent's own tool results for `t3_background_wait`.
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  HermesSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@t3tools/contracts";
import { AgentScope, AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  HERMES_FAST_MODE_CONFIG_ID,
  resolveHermesFastModeSelection,
} from "../../hermes/hermesFastMode.ts";
import { applyHermesReasoningSelection } from "../../hermes/hermesReasoningOptions.ts";
import type { HermesReasoningLevel } from "../../hermes/hermesReasoning.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  hermesApprovalOptions,
  discardLostHermesTurnsOnPrompt,
  extractHermesAwaitableBackgroundTasks,
  hermesPromptFailure,
  hideHermesStopNotices,
  isHermesGatewayTurnLoss,
  makeHermesAcpRuntime,
  makeHermesEditApprovalCards,
  normalizeHermesT3McpToolCall,
  normalizeHermesTerminalResult,
  normalizeHermesWebSearchQuery,
  preserveHermesAgentActivityTitle,
  readHermesCompressReply,
  resolveHermesAcpBaseModelId,
  resolveHermesSessionModeId,
} from "../../provider/acp/HermesAcpSupport.ts";
import { makeHermesSubagentExtractor } from "../../provider/acp/HermesDelegation.ts";
import * as HermesSpareRuntime from "../../provider/acp/HermesSpareRuntime.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
const DEFAULT_HERMES_SETTINGS = Schema.decodeSync(HermesSettings)({});

export const HermesProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
  streaming: {
    ...AcpProviderCapabilitiesV2.streaming,
    // The gateway projects only `tool.start` and `tool.complete`; a command's output arrives whole.
    streamsToolOutput: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface HermesAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: HermesSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** Replaces the `hermes acp` spawn; tests point it at the mock agent. */
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
  readonly assertComplete?: AcpAdapterV2Flavor["assertComplete"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Keep a `hermes acp` booting for the next session to adopt. */
  readonly spareRuntime?: boolean;
}

/**
 * Full access turns on YOLO, which subagents need for dangerous commands; a reopened session
 * follows it only with the `acp-launch-yolo-resume` patch. Thread MCP credentials go in
 * `session/new`, never here: Hermes's shared gateway inherits the environment of the viewer
 * that started it.
 */
export function hermesSpawnEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeMode: RuntimeMode,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(runtimeMode === "full-access" ? { HERMES_YOLO_MODE: "1" } : {}),
  };
}

/**
 * With the `acp-editor-delegation` patch, the model waits for its subagents inside the turn unless
 * it backgrounds them, and subagents can launch subagents up to three levels deep, as Claude's and
 * Codex's can. Stock Hermes ignores it: delegations detach, and children cannot delegate.
 */
const HERMES_DELEGATION_META = { hermes: { delegation: { foreground: true, maxSpawnDepth: 3 } } };

/** The services the Hermes flavor writes reasoning config with. */
interface HermesFlavorServices {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

function hermesRuntimeLauncher(options: HermesAdapterV2Options): AcpAdapterV2Flavor["makeRuntime"] {
  return (
    options.makeRuntime ??
    (({ runtimePolicy, processEnvironment: _processEnvironment, ...runtimeInput }) =>
      makeHermesAcpRuntime({
        ...runtimeInput,
        hermesSettings: options.settings,
        environment: hermesSpawnEnvironment(options.environment, runtimePolicy.runtimeMode),
        childProcessSpawner: options.childProcessSpawner,
      }))
  );
}

/** What a spare launches with; the adopting session binds its own before the first request. */
function hermesSpareRuntimeInput(runtimeMode: RuntimeMode): AcpAdapterV2RuntimeInput {
  return {
    cwd: process.cwd(),
    runtimePolicy: { runtimeMode, interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE, cwd: null },
    mcpServers: [],
    clientCapabilities: undefined,
    clientInfo: { name: "t3-code", version: "0.0.0" },
    protocolLogging: { logIncoming: false, logOutgoing: false },
    onTermination: () => Effect.void,
  };
}

export function makeHermesAcpAdapterFlavor(
  options: HermesAdapterV2Options &
    HermesFlavorServices & { readonly spares?: HermesSpareRuntime.HermesSpareRuntimes },
): AcpAdapterV2Flavor {
  // Hermes reads reasoning effort from one `config.yaml` per profile, so
  // concurrent sessions serialize the write and the rebuild that reads it.
  const reasoningConfigPermit = Semaphore.makeUnsafe(1);
  // Per live process: the runtime mode it launched with (a mode change reopens
  // the session) and the reasoning level its agent was last built with.
  const runtimeModes = new WeakMap<AcpSessionRuntime.AcpSessionRuntime["Service"], RuntimeMode>();
  const builtReasoningLevels = new WeakMap<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    HermesReasoningLevel | null
  >();
  const sentFastModes = new WeakMap<AcpSessionRuntime.AcpSessionRuntime["Service"], boolean>();
  const editApprovalCards = makeHermesEditApprovalCards();
  const launchRuntime = hermesRuntimeLauncher(options);
  const adoptOrLaunchRuntime = Effect.fn("HermesAdapterV2.makeRuntime")(function* (
    input: AcpAdapterV2RuntimeInput,
  ) {
    const {
      runtimePolicy,
      processEnvironment: _processEnvironment,
      protocolLogging,
      ...binding
    } = input;
    // A spare's protocol logging was fixed when it spawned.
    const spare =
      options.spares === undefined ||
      protocolLogging.logIncoming === true ||
      protocolLogging.logOutgoing === true
        ? undefined
        : yield* options.spares.adopt(runtimePolicy.runtimeMode, binding);
    return spare ?? (yield* launchRuntime(input));
  });

  return {
    driver: HERMES_PROVIDER,
    runtimeHarness: "Hermes",
    capabilities: HermesProviderCapabilitiesV2,
    clientCapabilitiesMeta: HERMES_DELEGATION_META,
    // Hermes takes image blocks whatever its handshake advertises.
    supportsImagePrompts: true,
    supportsCompaction: true,
    compactionCommand: "/compress",
    // The gateway's `/undo N` (`session.mutate rewind`) drops the session's last N user turns. It
    // answers its own slash commands, and a Stop before admission, with no usage: no user turn.
    rewindSession: {
      command: (userTurns) => `/undo ${userTurns}`,
      confirmed: (reply, userTurns) => reply.startsWith(`Undid ${userTurns} turn`),
      promptAddedUserTurn: (response) => response.usage != null,
    },
    readCompactionReply: readHermesCompressReply,
    // Hermes has no plan mode of its own, so Plan mode's plan arrives as a reply block.
    proposedPlanBlocks: true,
    // The Hermes gateway runs a turn of its own when a background job finishes (`notify: true`) and
    // projects it to ACP viewers as session updates, with no `session/prompt` open. Without this
    // those frames were dropped, so the agent woke and worked while its thread showed nothing.
    enablePostSettleContinuation: true,
    resolveModelId: (selection) => resolveHermesAcpBaseModelId(selection.model),
    approvalOptions: hermesApprovalOptions,
    onPermissionRequest: editApprovalCards.onPermissionRequest,
    ignoreSessionUpdate: editApprovalCards.ignoreSessionUpdate,
    promptFailure: hermesPromptFailure,
    restartRuntimeAfterPromptFailure: isHermesGatewayTurnLoss,
    makeRuntime: (input) =>
      adoptOrLaunchRuntime(input).pipe(
        Effect.map((runtime) => hideHermesStopNotices(discardLostHermesTurnsOnPrompt(runtime))),
        Effect.tap((runtime) =>
          Effect.sync(() => runtimeModes.set(runtime, input.runtimePolicy.runtimeMode)),
        ),
      ),
    /**
     * Hermes builds its agent from `config.yaml`, so the level is written first and an unchanged
     * model is re-sent when only the level moved. Edit-approval modes are best-effort since T3's
     * permission policy enforces approvals. Fast mode is re-pinned per turn.
     */
    applyModelSelection: Effect.fn("HermesAdapterV2.applyModelSelection")(function* ({
      runtime,
      startResult,
      modelSelection,
    }) {
      const runtimeMode = runtimeModes.get(runtime);
      const modeId =
        runtimeMode === undefined
          ? undefined
          : resolveHermesSessionModeId({ runtimeMode, modeState: yield* runtime.getModeState });
      if (modeId !== undefined) {
        yield* runtime
          .setMode(modeId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Hermes session mode selection failed.", { cause, modeId }),
            ),
          );
      }
      const model = yield* reasoningConfigPermit.withPermit(
        Effect.gen(function* () {
          const level = yield* applyHermesReasoningSelection({
            model: modelSelection.model,
            selections: modelSelection.options,
            environment: options.environment,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, options.fileSystem),
            Effect.provideService(Path.Path, options.path),
          );
          const rebuild = level !== undefined && builtReasoningLevels.get(runtime) !== level;
          // Hermes speaks ACP v1 (`session/set_model`); an agent on v2 takes
          // the model as a config option instead.
          const modelOption =
            startResult.initializeResult.protocolVersion === 1
              ? undefined
              : (yield* runtime.getConfigOptions).find((option) => option.category === "model");
          const model = yield* applyHermesAcpModelSelection({
            runtime:
              modelOption === undefined
                ? runtime
                : { setSessionModel: (id) => runtime.setModel(id).pipe(Effect.as({})) },
            currentModelId:
              typeof modelOption?.currentValue === "string"
                ? modelOption.currentValue
                : currentHermesModelIdFromSessionSetup(startResult.sessionSetupResult),
            requestedModelId: resolveHermesAcpBaseModelId(modelSelection.model),
            ...(rebuild ? { forceReapply: true } : {}),
            mapError: (cause) => cause,
          });
          if (level !== undefined) builtReasoningLevels.set(runtime, level);
          return model;
        }),
      );
      const fastMode = resolveHermesFastModeSelection(modelSelection);
      if (fastMode !== undefined && sentFastModes.get(runtime) !== fastMode) {
        yield* runtime.setConfigOption(HERMES_FAST_MODE_CONFIG_ID, fastMode ? "on" : "off").pipe(
          Effect.andThen(Effect.sync(() => sentFastModes.set(runtime, fastMode))),
          Effect.catchCause((cause) =>
            Effect.logWarning("Hermes fast mode selection failed.", { cause, fastMode }),
          ),
        );
      }
      return model;
    }),
    normalizeToolCall: (toolCall, sessionId) =>
      editApprovalCards.normalizeToolCall(
        preserveHermesAgentActivityTitle(
          normalizeHermesWebSearchQuery(
            normalizeHermesTerminalResult(normalizeHermesT3McpToolCall(toolCall)),
          ),
        ),
        sessionId,
      ),
    extractSubagentUpdates: makeHermesSubagentExtractor(),
    extractAwaitableBackgroundTasks: extractHermesAwaitableBackgroundTasks,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeHermesAdapterV2 = Effect.fn("makeHermesAdapterV2")(function* (
  options: HermesAdapterV2Options,
) {
  const services: HermesFlavorServices = {
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
  };
  const launchRuntime = hermesRuntimeLauncher(options);
  const random = yield* SecureRandom.SecureRandom;
  const agentScope = yield* AgentScope;
  const spares =
    options.spareRuntime === true
      ? yield* HermesSpareRuntime.make({
          launch: (runtimeMode) =>
            launchRuntime(hermesSpareRuntimeInput(runtimeMode)).pipe(
              Effect.provideService(SecureRandom.SecureRandom, random),
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                options.childProcessSpawner,
              ),
              Effect.provideService(AgentScope, agentScope),
              // Replenishing forks from an adopting session; its thread must not own the spare.
              Effect.provideService(AgentScopeThreadId, undefined),
            ),
          initialRuntimeMode: DEFAULT_RUNTIME_MODE,
          // As long as an idle session keeps its own process.
          idleTimeout: "30 minutes",
        })
      : undefined;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeHermesAcpAdapterFlavor({
      ...options,
      ...services,
      ...(spares === undefined ? {} : { spares }),
    }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type HermesAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const HermesAdapterV2Driver: ProviderAdapterDriver<
  HermesSettings,
  HermesAdapterV2DriverEnv
> = {
  driverKind: HERMES_PROVIDER,
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeHermesAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        selfInvocation: yield* resolveSelfInvocation(),
        spareRuntime: input.enabled,
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: HERMES_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: HERMES_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Hermes ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
