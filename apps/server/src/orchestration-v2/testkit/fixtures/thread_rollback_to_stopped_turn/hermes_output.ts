import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { acpOutboundRequestsByProcess } from "../shared.ts";

/** Hermes has no `thread/revert`: `/undo 1` drops only the turn after the stopped one, in place. */
export function assertHermesUndoInPlace(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const processes = acpOutboundRequestsByProcess(transcript);
  assert.lengthOf(processes, 1, "the rollback must keep the Hermes session");
  assert.include(processes[0] ?? [], "/undo 1");
}
