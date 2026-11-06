import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_BACKGROUND_TASK_INTERRUPT_PROMPT = [
  "Live-test interrupting a turn that owns background work. You must make two terminal tool calls, one after the other. Do exactly this, with no extra steps.",
  "",
  "1) Call the terminal tool with background set to true, notify set to true, and this exact command:",
  "   sleep 30 && echo BG_INTERRUPT_DONE",
  "2) After that call returns, call the terminal tool again in the foreground (background false) with this exact command and wait for it:",
  `   node -e "setTimeout(() => console.log('FG_DONE'), 30000)"`,
  "3) After it finishes, reply with exactly FINISHED.",
].join("\n");

export function hermesBackgroundTaskInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_TASK_INTERRUPT_PROMPT },
      {
        type: "interrupt",
        targetRunIndex: 1,
        // The foreground command, after the background one.
        waitForTurnItemType: "command_execution",
        waitForTurnItemCount: 2,
      },
    ],
  };
}
