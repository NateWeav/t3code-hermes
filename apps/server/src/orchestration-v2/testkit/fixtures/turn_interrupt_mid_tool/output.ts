import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

/**
 * What Stop shows while a command runs, for any provider: the command row ends interrupted (so
 * Stop landed after it started and before it finished), and nothing under the run keeps running.
 */
export function assertTurnInterruptMidToolOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_MID_TOOL_PROMPT]);

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  const interruptRequest = projection.turnItems.find(
    (item) => item.type === "run_interrupt_request",
  );
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.lengthOf(commands, 1);
  assert.isDefined(interruptRequest);
  assert.isDefined(interruptResult);
  assert.equal(commands[0]!.status, "interrupted");
  assert.isNotNull(commands[0]!.completedAt);
  assert.include(commands[0]!.input, "node -e");
  assert.equal(interruptRequest.status, "completed");
  assert.equal(interruptResult.status, "interrupted");
  assert.equal(interruptResult.parentItemId, interruptRequest.id);
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  for (const node of projection.nodes) {
    assert.notEqual(node.status, "running", `${node.kind} node must settle when the run stops`);
    assert.isNotNull(node.completedAt);
  }
}
