import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_CONTINUE_PARENT_PROMPT,
  SUBAGENT_CONTINUE_PROMPT,
} from "../shared.ts";

/** The follow-up the parent sent its finished subagent: the child thread's second user message. */
export function continuationPrompt(child: OrchestrationV2ThreadProjection): string | undefined {
  return child.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : []))[1];
}

/** The continued subagent's child thread. */
export function continuedSubagentThread(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const childThreadId = projectionFor(result, transcript.scenario).subagents[0]?.childThreadId;
  const childProjection = childThreadId == null ? undefined : result.projections.get(childThreadId);
  assert.isDefined(childProjection, "the continued subagent has a child thread");
  return childProjection;
}

export function assertSubagentContinueOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 2 });
  assertUserMessagesInclude(projection, [
    SUBAGENT_CONTINUE_PROMPT,
    SUBAGENT_CONTINUE_PARENT_PROMPT,
  ]);
  assert.lengthOf(projection.subagents, 1);

  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.result, "continued subagent response");
  assert.equal(subagent.runId, projection.runs[1]!.id);
  assert.isNotNull(subagent.childThreadId);
  if (subagent.childThreadId === null) {
    throw new Error("Continued subagent is missing its child thread");
  }

  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.lengthOf(childProjection.runs, 0);
  assertUserMessagesInclude(childProjection, [subagent.prompt]);
  assert.isDefined(continuationPrompt(childProjection), "the subagent reopens on a follow-up");
  assert.isTrue(
    childProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text === "initial subagent response",
    ),
  );
  assert.isTrue(
    childProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text === "continued subagent response",
    ),
  );
}
