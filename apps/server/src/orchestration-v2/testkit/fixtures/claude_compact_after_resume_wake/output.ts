import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import {
  assertCompactionRuns,
  claudeCompactRuns,
} from "../claude_compact_after_peer_turn/output.ts";

// A background job's wake reply arrives around the resume; it shows once and settles nothing early.
export function assertCompactAfterResumeWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const runs = assertCompactionRuns(result, transcript);
  assert.deepEqual(
    runs.map((run) => run.status),
    runs.map(() => "completed"),
  );
  assert.deepEqual(
    runs.flatMap((run) => run.replies).filter((reply) => reply === "A_REPORTED"),
    ["A_REPORTED"],
  );
}

// Hermes's twin compacts after the idle release ended `hermes acp`: the next one reloads the session.
export function assertHermesCompactAfterResumeWakeDetails(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const requests = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && entry.label?.startsWith("request:") ? [entry.label] : [],
  );
  assert.deepEqual(
    requests.filter((label) => label !== "request:session/prompt"),
    ["request:initialize", "request:session/new", "request:initialize", "request:session/load"],
  );
}

// The acknowledged prompt uuid proves the unechoed wake result is foreign; it must not settle /compact.
// Already streamed wake text remains on the /compact run.
export function assertClaudeCompactAfterResumeWakeDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.deepEqual(claudeCompactRuns(projectionFor(result, transcript.scenario)), [
    {
      text: CLAUDE_COMPACT_FIRST_PROMPT,
      fromUser: true,
      status: "completed",
      replies: ["compact probe first turn"],
      compactions: [],
    },
    {
      text: "/compact",
      fromUser: true,
      status: "completed",
      replies: ["A_REPORTED"],
      compactions: [[27445, 1192]],
    },
  ]);
}
