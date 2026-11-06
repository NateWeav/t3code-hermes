import type { OrchestratorFixtureInput } from "../shared.ts";

export const HERMES_TOOL_CALL_DENIED_WRITE_TARGET = ".hermes-denied-write.txt";

/** `tool_call_denied_write` in Hermes's tool names: `write_file`, and `terminal` for the shell. */
export const HERMES_TOOL_CALL_DENIED_WRITE_PROMPT = `Use the write_file tool once to create ${HERMES_TOOL_CALL_DENIED_WRITE_TARGET} containing exactly: approval fixture. If permission is denied, do not retry or use another tool; reply exactly: write permission denied. Do not read any files, use the terminal, network, or MCP.`;

export function hermesToolCallDeniedWriteInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: HERMES_TOOL_CALL_DENIED_WRITE_PROMPT },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}
