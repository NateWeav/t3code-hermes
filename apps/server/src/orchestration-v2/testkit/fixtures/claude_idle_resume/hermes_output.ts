import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { acpOutboundRequestsByProcess } from "../shared.ts";
import { assertIdleResumeConversation } from "./output.ts";

/**
 * Hermes reports session-wide usage that T3 does not split per turn, so Claude's per-turn ledger
 * is not checked. The fresh process must load the same session before the second prompt.
 */
export function assertHermesIdleResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertIdleResumeConversation(result, transcript);
  const processes = acpOutboundRequestsByProcess(transcript);
  assert.lengthOf(processes, 2, "the idle release must end the first Hermes process");
  const resumed = processes[1] ?? [];
  assert.notInclude(resumed, "session/new", "the second turn must resume the first session");
  const load = resumed.indexOf("session/load");
  assert.isAtLeast(load, 0, "the fresh process must load the session");
  assert.isAbove(resumed.indexOf("session/prompt"), load);
}
