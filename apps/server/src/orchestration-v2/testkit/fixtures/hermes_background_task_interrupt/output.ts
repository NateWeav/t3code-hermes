import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { hermesBackgroundProcessIds } from "../hermes_background_task_wake/output.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { HERMES_BACKGROUND_TASK_INTERRUPT_PROMPT } from "./input.ts";

/** `assertClaudeBackgroundTaskInterruptOutput` with Hermes's `proc_…` id for the task. */
export function assertHermesBackgroundTaskInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [HERMES_BACKGROUND_TASK_INTERRUPT_PROMPT]);

  const [backgroundTaskId] = hermesBackgroundProcessIds(transcript);
  assert.isDefined(backgroundTaskId, "Hermes must start the command as a background process");
  const rosterIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.some((task) => task.taskId === backgroundTaskId),
  );
  const interruptedIndex = result.domainEvents.findIndex(
    (event) => event.type === "run.updated" && event.payload.status === "interrupted",
  );
  assert.isAtLeast(rosterIndex, 0, "the background task must reach the roster before interrupt");
  assert.isAbove(interruptedIndex, rosterIndex);
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
