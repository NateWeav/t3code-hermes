import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { HERMES_BACKGROUND_TASK_INTERRUPT_PROMPT } from "../hermes_background_task_interrupt/input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  firstBackgroundRosterTask,
  forScenario,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_TASK_INTERRUPT_PROMPT } from "./input.ts";

const PROMPTS = {
  claude_background_task_interrupt: CLAUDE_BACKGROUND_TASK_INTERRUPT_PROMPT,
  hermes_background_task_interrupt: HERMES_BACKGROUND_TASK_INTERRUPT_PROMPT,
};

export function assertBackgroundTaskInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [forScenario(transcript, PROMPTS)]);

  const { index: rosterIndex } = firstBackgroundRosterTask(result);
  const interruptedIndex = result.domainEvents.findIndex(
    (event) => event.type === "run.updated" && event.payload.status === "interrupted",
  );
  assert.isAbove(interruptedIndex, rosterIndex, "the background task reaches the roster first");
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);

  assert.lengthOf(projection.subagents, 0);
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "command_execution" ? [item.status] : [],
    ),
    ["completed", "interrupted"],
    "the background launch completed; the foreground command was interrupted",
  );
}

export function assertClaudeBackgroundTaskInterruptDetails(result: OrchestratorV2ScenarioResult) {
  assert.equal(firstBackgroundRosterTask(result).task.taskId, "bt3kw2qpn");
}
