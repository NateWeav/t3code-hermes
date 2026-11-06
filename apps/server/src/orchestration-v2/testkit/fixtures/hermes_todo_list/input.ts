import { TODO_LIST_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

// Codex's prompt with its tool names mapped to Hermes's, so the reference assertion applies.
const HERMES_TODO_LIST_PROMPT = `${TODO_LIST_PROMPT}\n\nIn Hermes, update_plan is your todo tool, and read each file with cat in the terminal.`;

export function hermesTodoListInput(): OrchestratorFixtureInput {
  return {
    workspaceFiles: {
      "package.json": '{"name":"todo-list-fixture","private":true}\n',
      "tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
    },
    steps: [{ type: "message", text: HERMES_TODO_LIST_PROMPT }],
  };
}
