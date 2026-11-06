import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { field } from "../shared.ts";

export function assertHermesMessageSteeringDetails(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const methods = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [String(field(entry.frame, "method"))] : [],
  );
  // Patched Hermes steers natively: one prompt, one `_hermes/steer`, and no cancel-and-re-prompt.
  assert.deepEqual(
    ["session/prompt", "_hermes/steer", "session/cancel"].map(
      (method) => methods.filter((candidate) => candidate === method).length,
    ),
    [1, 1, 0],
  );
}
