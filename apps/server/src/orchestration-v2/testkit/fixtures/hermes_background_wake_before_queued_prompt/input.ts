import { CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT } from "../claude_background_subagent_lifecycle/input.ts";
import { HERMES_FIRST_UNPROMPTED_TURN_LABEL } from "../hermes_background_task_wake/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// One call per subagent: Hermes reports a batch only once every child in it has finished.
export const HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT = [
  "Live-test background subagents. You must call the delegate_task tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) In one message, make TWO separate delegate_task calls, each with ONE task (never both in one call's tasks):",
  '   - Agent A, goal: "Reply with exactly: A_FIRST"',
  '   - Agent B, goal: "Run this exact command with the terminal tool: sleep 60 && echo B_DONE. Then reply with exactly: B_FINAL"',
  "2) After both calls return, reply with exactly LAUNCHED and stop. Do not wait for them or check on them.",
  "3) When Agent A's completion is reported, reply with exactly A_REPORTED and stop.",
].join("\n");

// The sleep keeps the stop turn open until B's stop notification is queued behind it, as Claude's
// arrives during its stop turn, so the gateway runs that wake ahead of the resume prompt.
export const HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_STOP_PROMPT =
  'Stop Agent B now: call delegate_task with action "stop" and Agent B\'s subagent_id from its launch result. Then run this exact command with the terminal tool: sleep 12. Then reply with exactly: B_STOPPED';

// `continue` resumes a finished child; it comes with the delegation patch that adds it.
export const HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_RESUME_PROMPT = [
  'Use the delegate_task tool with action "continue" to send Agent A (its subagent_id from the launch result) this message: Reply with exactly: A_SECOND',
  "Then reply with exactly RESUMED and stop. When Agent A's new completion is reported, reply with exactly A_RESUME_REPORTED and stop.",
].join("\n");

export function hermesBackgroundWakeBeforeQueuedPromptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT },
      // Replay holds Agent A's wake turn until the root run settles, as its model call does live.
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: HERMES_FIRST_UNPROMPTED_TURN_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
      { type: "message", text: HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_STOP_PROMPT },
      // B's stop wakes the gateway, which runs that turn ahead of this prompt, inside its request.
      { type: "message", text: HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_RESUME_PROMPT },
      { type: "finish_held_run", targetRunIndex: 5, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT },
    ],
  };
}
