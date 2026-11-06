import type { OrchestratorFixtureInput } from "../shared.ts";

/** The recorder's label for the first update after a settled prompt: here, Hermes's wake turn. */
const WAKE_GATE = "notification:session/update:unprompted-1";

// The foreground output gives /compress an earlier stretch worth summarizing; it keeps the latest user turn.
export const HERMES_COMPACT_WAKE_PROMPT = [
  "Live-test compaction after a background terminal wake. Do exactly this, with no extra steps and no text before or between tool calls.",
  "",
  "1) Call the terminal tool three times, one call at a time, with these exact commands in order: echo alpha, then seq 1 1500, then seq 1501 3000.",
  "2) Call the terminal tool with background set to true, notify set to true, and this exact command:",
  "   sleep 8 && echo BG_DONE",
  "3) After that tool call returns, reply with exactly STARTED and stop. Do not poll, read its output, or wait for it.",
  "4) When its completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

export function hermesCompactAfterResumeWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_COMPACT_WAKE_PROMPT },
      // Replay holds the gateway's wake turn until the root run settles, as the sleep does live.
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: WAKE_GATE },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
      // The idle release ends the Hermes process, so /compress runs on the reloaded session.
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: "/compress" },
    ],
  };
}
