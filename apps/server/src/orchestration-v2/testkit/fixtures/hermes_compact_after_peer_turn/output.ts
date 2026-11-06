import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { claudeCompactRuns } from "../claude_compact_after_peer_turn/output.ts";
import { projectionFor } from "../shared.ts";

/** Hermes reports the compaction in its reply, and its wake turn reaches T3 after /compress settles. */
export function assertHermesCompactAfterPeerTurnDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const runs = claudeCompactRuns(projectionFor(result, transcript.scenario));
  assert.lengthOf(runs, 4);
  assert.match(runs[2]?.replies[0] ?? "", /^Compressed: \d+ → \d+ messages/u);
  const labels = transcript.entries.map((entry) => ("label" in entry ? entry.label : entry.type));
  assert.isAbove(
    labels.indexOf("notification:session/update:unprompted-2"),
    labels.lastIndexOf("response:session/prompt"),
  );
}
