import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  firstBackgroundRosterTask,
  projectionFor,
} from "../shared.ts";
import { HERMES_BACKGROUND_TASK_AFTER_ROOT_PROMPT } from "./input.ts";

export function assertHermesBackgroundTaskAfterRootOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [HERMES_BACKGROUND_TASK_AFTER_ROOT_PROMPT]);

  const rootRun = projection.runs[0];
  assert.isDefined(rootRun);
  const { task: rosterTask, index: pendingRosterIndex } = firstBackgroundRosterTask(result);
  assert.equal(rosterTask.kind, "command");
  const waitingRunIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.runId === rootRun.id &&
      event.payload.status === "waiting",
  );
  const waitingRootNodeIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "node.updated" &&
      event.payload.runId === rootRun.id &&
      event.payload.kind === "root_turn" &&
      event.payload.status === "waiting",
  );
  const idleRosterIndex = result.domainEvents.findIndex(
    (event, index) =>
      index > waitingRunIndex &&
      event.type === "provider-thread.updated" &&
      event.payload.status === "idle" &&
      (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
  );

  assert.isAbove(
    waitingRunIndex,
    pendingRosterIndex,
    "checkpoint-waiting root run must retain the background roster",
  );
  assert.isAbove(
    waitingRootNodeIndex,
    pendingRosterIndex,
    "checkpoint-waiting root node must retain the background roster",
  );
  assert.isAbove(
    idleRosterIndex,
    waitingRunIndex,
    "late background completion must clear the roster and return the provider thread to idle",
  );
  assert.equal(rootRun.status, "completed");
  const rootNode = projection.nodes.find(
    (node) => node.runId === rootRun.id && node.kind === "root_turn",
  );
  assert.isDefined(rootNode);
  assert.equal(rootNode.status, "completed");

  assert.lengthOf(projection.providerThreads, 1);
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  assert.lengthOf(projection.subagents, 0);

  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "assistant_message" ? [item.text.trim()] : [],
    ),
    ["L2_STARTED"],
  );

  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.isDefined(shell);
  assert.equal(shell.activeRunId, null);
  assert.equal(shell.status, "completed");
  assert.deepEqual(shell.pendingBackgroundTasks ?? [], []);
}
