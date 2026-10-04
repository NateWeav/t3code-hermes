/**
 * Hermes Agent (NousResearch/hermes-agent) over ACP stdio (`hermes acp`), as a
 * flavor of the shared ACP adapter. What differs from stock ACP: reasoning
 * effort lives in Hermes's `config.yaml`, delegated children arrive as one
 * `delegate_task` tool call, and the carried `acp-background-reports` patch
 * reports background processes and asks the client to prompt it once they
 * finish.
 *
 * @module orchestration-v2/Adapters/HermesAdapterV2
 */
import {
  HermesSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import { applyHermesReasoningSelection } from "../../hermes/hermesReasoningOptions.ts";
import type { HermesReasoningLevel } from "../../hermes/hermesReasoning.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import type * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
  normalizeHermesTerminalResult,
  preserveHermesAgentActivityTitle,
  resolveHermesAcpBaseModelId,
  resolveHermesSessionModeId,
} from "../../provider/acp/HermesAcpSupport.ts";
import {
  HERMES_NOTIFICATION_METHOD,
  HERMES_PROCESS_METHOD,
  HermesNotification,
  HermesProcessReport,
  hermesNotificationReport,
  hermesProcessMutation,
} from "../../provider/acp/HermesBackground.ts";
import { makeHermesSubagentExtractor } from "../../provider/acp/HermesDelegation.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

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
  readonly crypto: Crypto.Crypto;
  readonly selfInvocation: SelfInvocation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** Replaces the `hermes acp` spawn; tests point it at the mock agent. */
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

/**
 * Environment `hermes acp` runs with. Hermes subagents cannot ask for
 * approval, so they deny dangerous commands unless YOLO is on; full access has
 * to reach them too. The flag is process-wide, which is safe because a
 * runtime-mode change reopens the session.
 */
export function hermesSpawnEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeMode: RuntimeMode,
  processEnvironment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...processEnvironment,
    ...(runtimeMode === "full-access" ? { HERMES_YOLO_MODE: "1" } : {}),
  };
}

export function makeHermesAcpAdapterFlavor(options: HermesAdapterV2Options): AcpAdapterV2Flavor {
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

  const spawnRuntime = (input: AcpAdapterV2RuntimeInput) => {
    const { runtimePolicy, processEnvironment, ...runtimeInput } = input;
    return makeHermesAcpRuntime({
      ...runtimeInput,
      hermesSettings: options.settings,
      environment: hermesSpawnEnvironment(
        options.environment,
        runtimePolicy.runtimeMode,
        processEnvironment,
      ),
      childProcessSpawner: options.childProcessSpawner,
    });
  };

  return {
    driver: HERMES_PROVIDER,
    runtimeHarness: "Hermes",
    capabilities: HermesProviderCapabilitiesV2,
    // Hermes takes image blocks whatever its handshake advertises.
    supportsImagePrompts: true,
    supportsCompaction: true,
    compactionCommand: "/compress",
    resolveModelId: (selection) => resolveHermesAcpBaseModelId(selection.model),
    makeRuntime: (input) =>
      (options.makeRuntime ?? spawnRuntime)(input).pipe(
        Effect.tap((runtime) =>
          Effect.sync(() => runtimeModes.set(runtime, input.runtimePolicy.runtimeMode)),
        ),
      ),
    /**
     * Hermes resolves reasoning effort from `config.yaml` when it builds an
     * agent, and `session/set_model` rebuilds it, so the level is written first
     * and an unchanged model is re-sent when only the level moved. Hermes also
     * exposes its edit-approval policy as session modes; a build that offers
     * no matching mode, or rejects the switch, still runs, because T3's own
     * permission policy is what enforces approvals.
     */
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      Effect.gen(function* () {
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
        return yield* reasoningConfigPermit.withPermit(
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
      }),
    normalizeToolCall: (toolCall) =>
      preserveHermesAgentActivityTitle(normalizeHermesTerminalResult(toolCall)),
    extractSubagentUpdates: makeHermesSubagentExtractor(),
    registerExtensions: ({ runtime, applyBackgroundTaskMutation, offerWakePrompt }) =>
      runtime
        .handleExtNotification(HERMES_PROCESS_METHOD, HermesProcessReport, (report) =>
          applyBackgroundTaskMutation(hermesProcessMutation(report)),
        )
        .pipe(
          Effect.andThen(
            runtime.handleExtNotification(
              HERMES_NOTIFICATION_METHOD,
              HermesNotification,
              (notice) =>
                offerWakePrompt({
                  sessionId: notice.sessionId,
                  text: notice.text,
                  report: hermesNotificationReport(notice),
                }),
            ),
          ),
        ),
  };
}

export function makeHermesAdapterV2(options: HermesAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeHermesAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
}

export type HermesAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const HermesAdapterV2Driver: ProviderAdapterDriver<
  HermesSettings,
  HermesAdapterV2DriverEnv
> = {
  driverKind: HERMES_PROVIDER,
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => DEFAULT_HERMES_SETTINGS,
  create: Effect.fn("HermesAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<HermesSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeHermesAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
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
