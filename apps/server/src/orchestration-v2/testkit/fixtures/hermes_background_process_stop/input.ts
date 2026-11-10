import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_BACKGROUND_PROCESS_STOP_COMMAND = "sleep 300";

export const HERMES_BACKGROUND_PROCESS_STOP_PROMPT = [
  "Live-test a background process left running. You must call the terminal tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) Call the terminal tool with background set to true, notify set to false, and this exact command:",
  `   ${HERMES_BACKGROUND_PROCESS_STOP_COMMAND}`,
  "2) After that tool call returns, reply with exactly STARTED and stop. Do not poll, read its output, wait for it, or stop it.",
].join("\n");

export function hermesBackgroundProcessStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_BACKGROUND_PROCESS_STOP_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}
