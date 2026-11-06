import { CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT } from "../claude_background_task_wake/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

/** The recorder's label for the first update of Hermes's first unprompted (gateway) turn. */
export const HERMES_FIRST_UNPROMPTED_TURN_LABEL = "notification:session/update:unprompted-1";

export const HERMES_BACKGROUND_TASK_WAKE_PROMPT = [
  "Live-test a background terminal wake. You must call the terminal tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) Call the terminal tool with background set to true, notify set to true, and this exact command:",
  "   sleep 8 && echo BG_DONE",
  "2) After that tool call returns, reply with exactly STARTED and stop. Do not poll, read its output, or wait for it.",
  "3) When its completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

export function hermesBackgroundTaskWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_TASK_WAKE_PROMPT },
      // Replay holds the gateway's wake turn until the root run settles, as the sleep does live.
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: HERMES_FIRST_UNPROMPTED_TURN_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT },
    ],
  };
}
