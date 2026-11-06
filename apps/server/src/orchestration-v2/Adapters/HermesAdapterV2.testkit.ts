import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HermesSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { makeHermesAdapterV2 } from "./HermesAdapterV2.ts";

export const HERMES_PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("hermes");
const REPLAY_SETTINGS = Schema.decodeSync(HermesSettings)({ enabled: true });

function layerHermesProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectory({ prefix: `t3-orchestration-v2-hermes-replay-${transcript.scenario}-` })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeHermesAdapterV2({
        instanceId: HERMES_DEFAULT_INSTANCE_ID,
        settings: REPLAY_SETTINGS,
        // Reasoning-effort writes land here, never in a real Hermes profile.
        environment: { HERMES_HOME: replayDir },
        childProcessSpawner,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests,
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
          ...(replayGate === undefined ? {} : { replayGate }),
        }),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        ...(replayGate === undefined
          ? {}
          : {
              testHooks: {
                onDeferredFinalizeScheduled: (debounce) =>
                  Effect.sync(() => replayGate.recordFinishArmed(debounce)),
              },
            }),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(layerHost, NodeServices.layer, NodeCrypto.layer, IdAllocator.layer),
    ),
    // Held inbound lines must not outlive the scenario and wedge teardown.
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const HermesOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: HERMES_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, HERMES_PROVIDER),
  makeProviderAdapterRegistryLayer: layerHermesProviderAdapterRegistryReplay,
};
