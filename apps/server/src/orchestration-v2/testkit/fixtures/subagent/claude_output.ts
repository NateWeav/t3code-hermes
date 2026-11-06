import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertExecutionNodeKinds,
  assertTurnItemTypes,
  projectionFor,
} from "../shared.ts";

/** Claude's Agent prompts, SDK progress text, and the fixture workspace's file contents. */
export function assertClaudeSubagentDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertAssistantTextIncludes(projection, "claude-read-only-fixture");
  assertAssistantTextIncludes(projection, "ES2022");
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt ===
          "Read the file `package.json` in the current working directory and return its full contents." &&
        subagent.result?.includes("claude-read-only-fixture"),
    ),
  );
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt ===
          "Read the file `tsconfig.json` in the current working directory and return its full contents." &&
        subagent.result?.includes("ES2022"),
    ),
  );
  for (const subagent of projection.subagents) {
    const expectedProgress = subagent.prompt.includes("package.json")
      ? "Summarizing package.json"
      : "Reading tsconfig.json";
    assert.equal(subagent.driver, "claudeAgent");
    assert.equal(subagent.progress, expectedProgress);
    assert.isNull(subagent.providerThreadId);
    if (subagent.childThreadId === null) {
      throw new Error(`Subagent ${subagent.id} is missing its child thread`);
    }

    const childProjection = result.projections.get(subagent.childThreadId);
    assert.isDefined(childProjection);
    assert.isNull(childProjection.thread.activeProviderThreadId);
    assert.lengthOf(childProjection.providerThreads, 0);
    assert.lengthOf(childProjection.providerTurns, 0);
    assertExecutionNodeKinds(childProjection, ["root_turn", "tool_call"]);
    assertTurnItemTypes(childProjection, ["user_message", "dynamic_tool", "assistant_message"]);
    assert.isFalse(
      childProjection.turnItems.some(
        (item) => item.type === "reasoning" && item.text === expectedProgress,
      ),
      `child thread ${subagent.childThreadId} must not repeat the subagent's progress`,
    );

    const parentItem = projection.turnItems.find(
      (item) => item.type === "subagent" && item.subagentId === subagent.id,
    );
    if (parentItem?.type !== "subagent") {
      throw new Error(`Missing parent lifecycle item for subagent ${subagent.id}`);
    }
    assert.equal(parentItem.progress, expectedProgress);
  }
}
