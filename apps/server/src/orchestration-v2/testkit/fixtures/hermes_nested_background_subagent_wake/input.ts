import { HERMES_FIRST_UNPROMPTED_TURN_LABEL } from "../hermes_background_task_wake/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// A Hermes subagent's own delegate_task always waits for its children, so the grandchild runs
// inside the child's call rather than in the background.
const HERMES_NESTED_BACKGROUND_SUBAGENT_WAKE_PROMPT = [
  "Live-test a background subagent that starts its own subagent. Do exactly this, with no extra steps.",
  "",
  "1) Use the delegate_task tool with background set to true to launch ONE subagent with this goal:",
  '   "Do exactly this. a) Use the delegate_task tool to launch ONE subagent with the goal: Reply with exactly GRANDCHILD_DONE. b) Run this exact command with the terminal tool: sleep 20 && echo CHILD_WAITED. c) Reply with exactly CHILD_DONE."',
  "2) Immediately after launching it, reply with exactly ROOT_STARTED and stop. Do not wait for it or check on it.",
  "3) When its completion is reported, reply with exactly ROOT_WAKE_DONE and stop.",
].join("\n");

export function hermesNestedBackgroundSubagentWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_NESTED_BACKGROUND_SUBAGENT_WAKE_PROMPT },
      // Replay holds the child's work after the root settled, and the gateway turn its end opens,
      // until the root run settles, as the child's work does live.
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: HERMES_FIRST_UNPROMPTED_TURN_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
