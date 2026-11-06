import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";

/** The idle release ends the first Hermes process; the next one loads the session for /compress. */
export function assertHermesCompactAfterResumeWakeDetails(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const requests = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound"
      ? [entry.label]
      : entry.type === "runtime_exit"
        ? ["exit"]
        : [],
  );
  const firstExit = requests.indexOf("exit");
  assert.isAbove(firstExit, 0, "the idle release must end the first Hermes process");
  const resumed = requests.slice(firstExit + 1);
  assert.notInclude(resumed, "request:session/new");
  const load = resumed.indexOf("request:session/load");
  assert.isAtLeast(load, 0, "the fresh process must load the session");
  assert.isAbove(resumed.indexOf("request:session/prompt"), load);
}
