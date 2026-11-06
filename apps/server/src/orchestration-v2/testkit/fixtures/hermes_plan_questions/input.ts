import { PLAN_QUESTIONS_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

// Codex's prompt with its tool name mapped to Hermes's, so the reference assertion applies.
const HERMES_PLAN_QUESTIONS_PROMPT = `${PLAN_QUESTIONS_PROMPT}\n\nIn Hermes, request_user_input is your clarify tool.`;

export function hermesPlanQuestionsInput(): OrchestratorFixtureInput {
  return {
    interactionMode: "plan",
    steps: [
      { type: "message", text: HERMES_PLAN_QUESTIONS_PROMPT },
      // Hermes's clarify form has one field, `answer`.
      { type: "answer_next_user_input_request", answers: { answer: "Strict schemas" } },
    ],
  };
}
