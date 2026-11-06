import { CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT } from "../claude_background_subagent_lifecycle/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

/** Agent A's model: one the benchmark profile lists besides its own default. */
export const HERMES_LIFECYCLE_AGENT_A_MODEL = "claude-haiku-4-5-20251001";

export const HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT = [
  "Live-test background subagents. You must call the delegate_task tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) Make TWO separate delegate_task calls in one message, each with background set to true and ONE task (never both in one call's tasks):",
  `   - Agent A, with model "${HERMES_LIFECYCLE_AGENT_A_MODEL}" and goal: "Reply with exactly: A_FIRST"`,
  '   - Agent B, with no model and goal: "Run this exact command with the terminal tool in the foreground (background false) and wait for it: sleep 90 && echo B_DONE. Then reply with exactly: B_FINAL"',
  "2) After both calls return, reply with exactly LAUNCHED and stop. Do not wait for them or check on them.",
  "3) When Agent A's result is reported, reply with exactly A_REPORTED and stop.",
].join("\n");

export const HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT =
  'Stop Agent B now with the delegate_task tool (action "stop" and its subagent_id from the launch result). Then reply with exactly: B_STOPPED';

export const HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT = [
  'Use the delegate_task tool with action "continue" and background set to true to send Agent A (its subagent_id from the launch result) this message: Reply with exactly: A_SECOND',
  "Then reply with exactly RESUMED and stop. When Agent A's new result is reported, reply with exactly A_RESUME_REPORTED and stop.",
].join("\n");

const unpromptedTurn = (n: number) => `notification:session/update:unprompted-${n}`;

// Replay holds each gateway turn that hands a result back until the run before it settles, as live.
export function hermesBackgroundSubagentLifecycleInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: unpromptedTurn(1) },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
      { type: "message", text: HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
      { type: "release_replay_gate", label: unpromptedTurn(2) },
      { type: "finish_held_run", targetRunIndex: 4, status: "completed" },
      { type: "message", text: HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT },
      { type: "await_run_status", targetRunIndex: 5, status: "completed" },
      { type: "release_replay_gate", label: unpromptedTurn(3) },
      { type: "finish_held_run", targetRunIndex: 6, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT },
    ],
  };
}
