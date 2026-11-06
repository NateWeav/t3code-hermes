import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT } from "../claude_background_task_wake/input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import { HERMES_BACKGROUND_TASK_WAKE_PROMPT } from "./input.ts";

const BACKGROUND_COMMAND = "sleep 8 && echo BG_DONE";

/** The `proc_…` ids Hermes's background `terminal` results gave the agent, in start order. */
export function hermesBackgroundProcessIds(
  transcript: ProviderReplayTranscript,
): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const match = /- \*\*session_id:\*\* (proc_[0-9a-f]+)/.exec(JSON.stringify(entry.frame));
    return match === null ? [] : [match[1]!];
  });
}

function runAssistantTexts(
  projection: OrchestrationV2ThreadProjection,
  runId: string | undefined,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

/**
 * `assertClaudeBackgroundTaskWakeOutput` with Hermes's identities: the roster carries the `proc_…`
 * id and the command (Hermes's terminal takes no description). Hermes's wake turn reaches ACP
 * viewers without the completion notice it answers, so the wake's outcome is unknown and its
 * message has no provider summary to compare.
 */
export function assertHermesBackgroundTaskWakeOutput(
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
    HERMES_BACKGROUND_TASK_WAKE_PROMPT,
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

  const [backgroundTaskId] = hermesBackgroundProcessIds(transcript);
  assert.isDefined(backgroundTaskId, "Hermes must start the command as a background process");
  const rosterIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.some((task) => task.taskId === backgroundTaskId),
  );
  const clearedIndex = result.domainEvents.findIndex(
    (event, index) =>
      index > rosterIndex &&
      event.type === "provider-thread.updated" &&
      (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
  );
  assert.isAtLeast(rosterIndex, 0, "the running background task must reach the roster");
  assert.isAbove(clearedIndex, rosterIndex, "the completed task must leave the roster");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);

  const rosterTask = result.domainEvents
    .flatMap((event) =>
      event.type === "provider-thread.updated" ? (event.payload.pendingBackgroundTasks ?? []) : [],
    )
    .find((task) => task.taskId === backgroundTaskId);
  assert.deepEqual(rosterTask, {
    taskId: backgroundTaskId,
    description: BACKGROUND_COMMAND,
    kind: "command",
  });
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: `Command "${BACKGROUND_COMMAND}" finished`,
      outcome: "unknown",
      source: { kind: "command" },
    },
  ]);

  assert.lengthOf(projection.subagents, 0);
  assert.isFalse(projection.nodes.some((node) => node.kind === "subagent"));
}
