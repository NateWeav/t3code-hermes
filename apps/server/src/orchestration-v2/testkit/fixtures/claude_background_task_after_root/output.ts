import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { HERMES_BACKGROUND_TASK_AFTER_ROOT_PROMPT } from "../hermes_background_task_after_root/input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  firstBackgroundRosterTask,
  forScenario,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT } from "./input.ts";

const PROMPTS = {
  claude_background_task_after_root: CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT,
  hermes_background_task_after_root: HERMES_BACKGROUND_TASK_AFTER_ROOT_PROMPT,
};

export function assertBackgroundTaskAfterRootOutput(
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
  assertUserMessagesInclude(projection, [forScenario(transcript, PROMPTS)]);

  const rootRun = projection.runs[0];
  const wakeRun = projection.runs[1];
  assert.isDefined(rootRun);
  assert.isDefined(wakeRun);
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
  const clearedRosterIndex = result.domainEvents.findIndex(
    (event, index) =>
      index > waitingRunIndex &&
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.length === 0,
  );
  const wakeRunIndex = result.domainEvents.findIndex(
    (event) => event.type === "run.created" && event.payload.id === wakeRun.id,
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
  assert.isAbove(wakeRunIndex, waitingRunIndex, "the wake must follow the root turn");
  assert.isAbove(
    clearedRosterIndex,
    wakeRunIndex,
    "the background task must remain pending until its wake run consumes the completion",
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
    ["L2_STARTED", "L2_WAKE: L2_BG_DONE"],
  );

  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.isDefined(shell);
  assert.equal(shell.activeRunId, null);
  assert.equal(shell.status, "completed");
  assert.deepEqual(shell.pendingBackgroundTasks ?? [], []);
}

export function assertClaudeBackgroundTaskAfterRootDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(firstBackgroundRosterTask(result).task.taskId, "bc9gkn8ei");
  const projection = projectionFor(result, transcript.scenario);
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "assistant_message" ? [item.text] : [])),
    ["L2_STARTED"],
  );
}
