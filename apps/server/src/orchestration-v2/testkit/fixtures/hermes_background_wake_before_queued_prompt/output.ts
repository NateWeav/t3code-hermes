import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The gateway ran B's stop wake inside the resume prompt's request: its reply arrives there stamped
 * `_meta.hermes.unprompted`, all of it ahead of the prompt's own unstamped reply.
 */
export function assertHermesBackgroundWakeBeforeQueuedPromptDetails(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const { entries } = transcript;
  const resumeIndex = entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" &&
      entry.label === "request:session/prompt" &&
      JSON.stringify(field(entry.frame, "params")).includes("A_SECOND"),
  );
  assert.isAtLeast(resumeIndex, 0, "the resume prompt was sent");
  const responseIndex = entries.findIndex(
    (entry, index) =>
      index > resumeIndex &&
      entry.type === "emit_inbound" &&
      entry.label === "response:session/prompt",
  );
  const stamped = entries.slice(resumeIndex + 1, responseIndex).flatMap((entry) => {
    const params = field(entry.type === "emit_inbound" ? entry.frame : undefined, "params");
    if (field(field(params, "update"), "sessionUpdate") !== "agent_message_chunk") return [];
    return [field(field(field(params, "_meta"), "hermes"), "unprompted") === true];
  });
  const ownReplyStart = stamped.indexOf(false);
  assert.isAbove(ownReplyStart, 0, "the wake's reply streams ahead of the prompt's own reply");
  assert.notInclude(
    stamped.slice(ownReplyStart),
    true,
    "the wake's reply ends before the prompt's",
  );
}
