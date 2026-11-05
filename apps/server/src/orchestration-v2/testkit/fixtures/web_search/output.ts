import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  WEB_SEARCH_PROMPT,
} from "../shared.ts";
import { assertClaudeWebSearchOutput } from "./claude_output.ts";
import { assertWebSearchOutput as assertCodexWebSearchOutput } from "./codex_output.ts";

// Each reference recording also keeps the checks that pin its own provider's shapes.
const RECORDING_CHECKS: Partial<
  Record<
    string,
    (result: OrchestratorV2ScenarioResult, transcript: ProviderReplayTranscript) => void
  >
> = {
  claudeAgent: assertClaudeWebSearchOutput,
  codex: assertCodexWebSearchOutput,
};

/** Any provider: one completed search card that names the query, then the answer. */
export function assertProviderNeutralWebSearchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "tool_call", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [WEB_SEARCH_PROMPT]);
  const [first, ...replies] = projection.messages.map((message) => message.role);
  assert.equal(first, "user");
  assert.isNotEmpty(replies);
  assert.isTrue(replies.every((role) => role === "assistant"));

  const searches = projection.turnItems.filter((item) => item.type === "web_search");
  assert.lengthOf(searches, 1);
  const search = searches[0]!;
  assert.equal(search.status, "completed");
  assert.isTrue(
    (search.patterns ?? []).some(
      (pattern) => /world cup/i.test(pattern) && /ticket/i.test(pattern),
    ),
    `the search card must name the query: ${JSON.stringify(search.patterns)}`,
  );
  const answerIndex = projection.turnItems.findLastIndex(
    (item) => item.type === "assistant_message",
  );
  const answer = projection.turnItems[answerIndex];
  assert.include(
    answer?.type === "assistant_message" ? answer.text : "",
    "web search fixture complete",
  );
  assert.isBelow(
    projection.turnItems.indexOf(search),
    answerIndex,
    "the answer follows the search",
  );

  RECORDING_CHECKS[transcript.provider]?.(result, transcript);
}
