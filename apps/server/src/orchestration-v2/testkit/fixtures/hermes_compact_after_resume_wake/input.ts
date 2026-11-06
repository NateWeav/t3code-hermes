import {
  HERMES_FIRST_WAKE_LABEL,
  hermesCompactFirstPrompt,
} from "../hermes_compact_after_peer_turn/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_COMPACT_RESUME_FIRST_PROMPT = hermesCompactFirstPrompt("A_REPORTED");

// The wake settles, the idle release ends `hermes acp`, and /compress reopens the session.
export function hermesCompactAfterResumeWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_COMPACT_RESUME_FIRST_PROMPT },
      { type: "release_replay_gate", label: HERMES_FIRST_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: "/compress" },
    ],
  };
}
