import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
} from "../shared.ts";

/**
 * Stop during a command, then a new message, for any provider: the stopped run keeps its
 * interrupted command row and the next message is answered in the same provider conversation.
 */
export function assertTurnInterruptRestartOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["interrupted", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "user", "assistant"]);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
    "assistant_message",
  ]);
  assertUserMessagesInclude(projection, [
    TURN_INTERRUPT_MID_TOOL_PROMPT,
    TURN_INTERRUPT_RECOVERY_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, "interrupt recovery fixture complete");
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted", "completed"],
  );
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted", "completed"],
  );
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "run_interrupt_request"),
    1,
  );
  assert.lengthOf(projection.providerThreads, 1, "the next message continues the conversation");
  assert.equal(projection.providerThreads[0]?.status, "idle");
  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  assert.equal(commandItem.status, "interrupted");
  assert.include(commandItem.input, "node -e");
}
