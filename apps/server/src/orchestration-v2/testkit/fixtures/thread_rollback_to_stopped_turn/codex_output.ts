import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertVisibleUserMessagesExclude,
  assertVisibleUserMessagesInclude,
  projectionFor,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

export function assertCodexThreadRevert(
  _result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const revert = transcript.entries.find(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      Reflect.get(entry.frame, "method") === "thread/revert",
  );
  assert.isDefined(revert, "rollback must revert the Codex thread");
}

/** The stopped turn keeps its checkpoint and stays in the conversation the agent recalls. */
export function assertRollbackToStoppedTurnConversation(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 4,
    runStatuses: ["completed", "interrupted", "rolled_back", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2, 3, 4]);

  const stoppedRun = projection.runs.find((run) => run.ordinal === 2);
  const stoppedCheckpoint = projection.checkpoints.find(
    (checkpoint) => checkpoint.appRunOrdinal === 2,
  );
  assert.equal(stoppedCheckpoint?.status, "ready");
  assert.equal(stoppedCheckpoint?.runId, stoppedRun?.id);
  assert.equal(stoppedRun?.checkpointId, stoppedCheckpoint?.id);

  assertVisibleUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    TURN_INTERRUPT_MID_TOOL_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesExclude(projection, [THREAD_ROLLBACK_SECOND_PROMPT]);

  const recall = projection.turnItems.findLast((item) => item.type === "assistant_message");
  const recallText = recall?.type === "assistant_message" ? recall.text : "";
  assert.include(recallText, "rollback fixture first turn complete");
  assert.include(recallText, "interrupt fixture tool started");
  assert.notInclude(recallText, "rollback fixture second turn complete");
}
