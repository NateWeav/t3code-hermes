import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertRunOrdinals,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  PLAN_QUESTIONS_PROMPT,
  projectionFor,
} from "../shared.ts";

/** One user-input request the user answers, then the exact reply: what every provider shares. */
export function assertPlanQuestionsOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1]);
  assertExecutionNodeKinds(projection, ["root_turn", "user_input_request", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["user_input"]);
  assertAllRuntimeRequestsResolved(projection);
  assertTurnItemTypes(projection, ["user_message", "user_input_request", "assistant_message"]);
  // The question shows once, as the request; no tool card repeats it.
  assert.notInclude(
    projection.turnItems.map((item) => item.type),
    "dynamic_tool",
  );
  assertUserMessagesInclude(projection, [PLAN_QUESTIONS_PROMPT]);
  assertAssistantTextIncludes(projection, "plan questions fixture complete");
}

function assertPlanQuestionId(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
  questionId: string,
) {
  const projection = projectionFor(result, transcript.scenario);
  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.isDefined(requestItem);
  assert.equal(requestItem?.questions[0]?.id, questionId);
}

/** The question id the Grok and ACP registry models chose. */
export function assertSchemaFlexibilityQuestionId(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertPlanQuestionId(result, transcript, "schema_vs_ui_flexibility");
}

/** The question id Codex's model chose for request_user_input. */
export function assertCodexPlanQuestionsDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertPlanQuestionId(result, transcript, "schema_preference");
}
