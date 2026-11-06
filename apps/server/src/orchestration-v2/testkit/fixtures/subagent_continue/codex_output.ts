import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { continuedSubagentThread } from "./output.ts";

/** Codex's child thread keeps a provider turn for the spawn and one for the continuation. */
export function assertCodexSubagentContinueDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.lengthOf(continuedSubagentThread(result, transcript).providerTurns, 2);
}
