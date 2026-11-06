import type { OrchestratorFixtureInput } from "../shared.ts";

/** The recorder's label for the first update Hermes sends after the first turn settles. */
export const HERMES_FIRST_WAKE_LABEL = "notification:session/update:unprompted-1";

// Hermes's peer turn is the gateway's own turn when a `notify` background job ends. The foreground
// output gives /compress enough history to remove.
export const hermesCompactFirstPrompt = (wakeReply: string) =>
  [
    "Use the terminal tool for each step and write no text until step 4.",
    "1. Run `seq 1 1500` in the foreground.",
    "2. Run `seq 1501 3000` in the foreground.",
    "3. Start `sleep 5 && echo compact-probe-done` as a background process with notify set to true. Do not wait for it.",
    "4. Reply with exactly: compact probe first turn",
    `When that background process's completion notification arrives, reply with exactly: ${wakeReply}`,
  ].join("\n");

export const HERMES_COMPACT_PEER_FIRST_PROMPT = hermesCompactFirstPrompt("PEER_ACK");

export function hermesCompactAfterPeerTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_COMPACT_PEER_FIRST_PROMPT },
      { type: "release_replay_gate", label: HERMES_FIRST_WAKE_LABEL },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
      { type: "message", text: "/compress" },
    ],
  };
}
