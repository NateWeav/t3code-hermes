import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { acpOutboundRequestsByProcess } from "../shared.ts";

/** The fresh process loads the released session, and rewinds it only once the load answered. */
export function assertHermesLoadBeforeUndo(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const processes = acpOutboundRequestsByProcess(transcript);
  assert.lengthOf(processes, 2, "the idle release must end the first Hermes process");
  const resumed = processes[1] ?? [];
  assert.notInclude(resumed, "session/new", "the rollback must keep the Hermes session");
  assert.isAbove(resumed.indexOf("/undo 1"), resumed.indexOf("session/load"));
  const loaded = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "response:session/load",
  );
  const undo = transcript.entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" && JSON.stringify(entry.frame).includes('"text":"/undo 1"'),
  );
  assert.isAtLeast(loaded, 0, "Hermes must answer session/load");
  assert.isAbove(undo, loaded, "the rewind must wait for the load response");
}
