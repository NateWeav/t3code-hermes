import type { OrchestratorFixtureInput } from "../shared.ts";

/** The recorder's label for the first update after /compress settles: Hermes's wake turn. */
const WAKE_GATE = "notification:session/update:unprompted-2";

// The foreground output gives /compress an earlier turn worth summarizing; it keeps the latest user turn.
export const HERMES_COMPACT_PEER_FIRST_PROMPT = [
  "Call the terminal tool three times, one call at a time, with these exact commands in order: echo alpha, then seq 1 1500, then seq 1501 3000. Write no text before or between the calls.",
  "Then reply with exactly: compact probe first turn",
].join("\n");

export const HERMES_COMPACT_PEER_WAKE_PROMPT = [
  "Live-test a background terminal wake. You must call the terminal tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) Call the terminal tool with background set to true, notify set to true, and this exact command:",
  "   sleep 10 && echo BG_DONE",
  "2) After that tool call returns, reply with exactly STARTED and stop. Do not poll, read its output, or wait for it.",
  "3) When its completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

/** /compress goes out while the background command sleeps, so Hermes's own wake turn lands behind it. */
export function hermesCompactAfterPeerTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_COMPACT_PEER_FIRST_PROMPT },
      { type: "message", text: HERMES_COMPACT_PEER_WAKE_PROMPT },
      { type: "message", text: "/compress" },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
      { type: "release_replay_gate", label: WAKE_GATE },
      { type: "finish_held_run", targetRunIndex: 4, status: "completed" },
    ],
  };
}
