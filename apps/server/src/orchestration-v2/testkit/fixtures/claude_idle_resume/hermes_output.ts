import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { acpOutboundRequestsByProcess } from "../shared.ts";

/** The fresh Hermes process loads the same session before the second prompt. */
export function assertHermesIdleResumeSession(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const processes = acpOutboundRequestsByProcess(transcript);
  assert.lengthOf(processes, 2, "the idle release must end the first Hermes process");
  const resumed = processes[1] ?? [];
  assert.notInclude(resumed, "session/new", "the second turn must resume the first session");
  const load = resumed.indexOf("session/load");
  assert.isAtLeast(load, 0, "the fresh process must load the session");
  assert.isAbove(resumed.indexOf("session/prompt"), load);
}
