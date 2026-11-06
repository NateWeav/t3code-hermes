import { HERMES_FIRST_UNPROMPTED_TURN_LABEL } from "../hermes_background_task_wake/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_BACKGROUND_TASK_AFTER_ROOT_PROMPT = [
  "Live-test post-settle background terminal wake. Do exactly this in order, with no extra steps.",
  "",
  "1) Run this exact command using the terminal tool with background set to true and notify set to true:",
  "   sleep 25 && echo L2_BG_DONE",
  "2) Immediately after starting it, reply with a short message containing exactly L2_STARTED and stop.",
  "3) Do NOT poll it with process_manage. Do NOT wait for it. Do not spawn subagents.",
  "4) If its completion is reported later, acknowledge it once by replying with exactly L2_WAKE: L2_BG_DONE and stop.",
  "",
  "The point is that your first turn ends while the command is still running.",
].join("\n");

export function hermesBackgroundTaskAfterRootInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_TASK_AFTER_ROOT_PROMPT },
      {
        type: "release_replay_gate_after_waiting",
        label: HERMES_FIRST_UNPROMPTED_TURN_LABEL,
        targetRunIndex: 1,
      },
    ],
  };
}
