import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import { claudeCompactRuns } from "../claude_compact_after_peer_turn/output.ts";

// Two messages leave Hermes nothing to compress; its reply says so and no compaction may show.
export function assertHermesCompressNoopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const runs = claudeCompactRuns(projection);
  assert.deepEqual(
    runs.map(({ text, status, compactions }) => ({ text, status, compactions })),
    [
      { text: CLAUDE_COMPACT_FIRST_PROMPT, status: "completed", compactions: [] },
      { text: "/compress", status: "completed", compactions: [] },
    ],
  );
  assert.match(runs[1]?.replies[0] ?? "", /^No changes from compression/u);
}
