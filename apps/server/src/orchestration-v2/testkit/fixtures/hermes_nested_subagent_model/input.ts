import { HERMES_LIFECYCLE_AGENT_A_MODEL } from "../hermes_background_subagent_lifecycle/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

/** The outer subagent's model: one the benchmark profile lists besides its own default. */
export const HERMES_NESTED_SUBAGENT_MODEL = HERMES_LIFECYCLE_AGENT_A_MODEL;

const HERMES_NESTED_SUBAGENT_MODEL_PROMPT = [
  "Live-test nested subagents. You must call the delegate_task tool before replying. Do exactly this, with no extra steps.",
  "",
  `1) Call delegate_task once with ONE task, model "${HERMES_NESTED_SUBAGENT_MODEL}", background false, and this goal:`,
  '   "Call the delegate_task tool once with ONE task, background false, no model, and the goal: Reply with exactly NESTED_LEAF_OK. Then reply with exactly what that subagent said."',
  "2) When it finishes, reply with exactly what it said.",
].join("\n");

export function hermesNestedSubagentModelInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: HERMES_NESTED_SUBAGENT_MODEL_PROMPT }],
  };
}
