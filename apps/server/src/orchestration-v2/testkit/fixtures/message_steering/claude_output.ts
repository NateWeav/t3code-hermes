import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";

export function assertClaudeMessageSteeringDetails(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "claudeAgent");
}
