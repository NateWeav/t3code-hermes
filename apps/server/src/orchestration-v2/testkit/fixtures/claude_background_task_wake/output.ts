import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { HERMES_BACKGROUND_TASK_WAKE_PROMPT } from "../hermes_background_task_wake/input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  firstBackgroundRosterTask,
  forScenario,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT,
  CLAUDE_BACKGROUND_TASK_WAKE_PROMPT,
} from "./input.ts";

const PROMPTS = {
  claude_background_task_wake: CLAUDE_BACKGROUND_TASK_WAKE_PROMPT,
  hermes_background_task_wake: HERMES_BACKGROUND_TASK_WAKE_PROMPT,
};

function runAssistantTexts(
  projection: OrchestrationV2ThreadProjection,
  runId: string | undefined,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

export function assertBackgroundTaskWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    forScenario(transcript, PROMPTS),
    CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT,
  ]);

  const [rootRun, wakeRun, userRun] = projection.runs;
  assert.deepEqual(runAssistantTexts(projection, rootRun?.id), ["STARTED"]);
  assert.deepEqual(runAssistantTexts(projection, wakeRun?.id), ["WAKE_DONE"]);
  assert.deepEqual(runAssistantTexts(projection, userRun?.id), ["USER_REPLY"]);

  const creators = projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return `${message?.createdBy}:${message?.creationSource}`;
  });
  assert.deepEqual(creators, ["user:web", "agent:provider", "user:web"]);

  const { task: rosterTask, index: rosterIndex } = firstBackgroundRosterTask(result);
  const clearedIndex = result.domainEvents.findIndex(
    (event, index) =>
      index > rosterIndex &&
      event.type === "provider-thread.updated" &&
      (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
  );
  assert.isAbove(clearedIndex, rosterIndex, "the completed task must leave the roster");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);

  assert.equal(rosterTask.kind, "command");
  assert.isNotEmpty(rosterTask.description);
  // The outcome is the provider's to report: Hermes's wake carries no exit status.
  assert.deepEqual(
    backgroundNotifications(projection).map(({ summary, source }) => ({ summary, source })),
    [{ summary: `Command "${rosterTask.description}" finished`, source: { kind: "command" } }],
  );

  assert.lengthOf(projection.subagents, 0);
  assert.isFalse(projection.nodes.some((node) => node.kind === "subagent"));
}

export function assertClaudeBackgroundTaskWakeDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(
    wakeMessage?.text,
    'Background command "Background sleep test" completed (exit code 0)',
  );
  assert.deepEqual(firstBackgroundRosterTask(result).task, {
    taskId: "bdqirlcyw",
    description: "Background sleep test",
    kind: "command",
  });
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Command "Background sleep test" finished',
      outcome: "completed",
      source: { kind: "command" },
    },
  ]);
}
