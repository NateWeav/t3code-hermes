import { HERMES_FIRST_UNPROMPTED_TURN_LABEL } from "../hermes_background_task_wake/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT = [
  "Live-test a background subagent that keeps working after your turn ends. Do exactly this, with no extra steps.",
  "",
  "1) Use the delegate_task tool to launch ONE subagent with this goal:",
  '   "Do 2 steps. Before each step, write exactly one line: SUB_STEP_N (N = 1, then 2). Then run this exact command with the terminal tool: sleep 3 && echo SUB_DONE_N. After both steps, reply with exactly: SUB_FINAL_REPORT"',
  "2) Immediately after launching it, reply with exactly ROOT_STARTED and stop. Do not wait for it or check on it.",
  "3) When its completion is reported, reply with exactly ROOT_WAKE_DONE and stop.",
].join("\n");

export function hermesBackgroundSubagentAfterRootInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT },
      // Replay holds the child's late completion, and the gateway turn it opens, until the root
      // run settles, as the child's work does live.
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: HERMES_FIRST_UNPROMPTED_TURN_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
