import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { SUBAGENT_CONTINUE_CHILD_PROMPT } from "../shared.ts";
import { continuationPrompt, continuedSubagentThread } from "./output.ts";

/**
 * Codex's child thread keeps a provider turn for the spawn and one for the continuation, and the
 * follow-up carries the wording Codex's model chose.
 */
export function assertCodexSubagentContinueDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const child = continuedSubagentThread(result, transcript);
  assert.lengthOf(child.providerTurns, 2);
  assert.include(continuationPrompt(child), SUBAGENT_CONTINUE_CHILD_PROMPT);
}
