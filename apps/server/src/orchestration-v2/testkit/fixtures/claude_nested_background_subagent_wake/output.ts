import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

const CHILD_TASK_ID = "a5d7d869cbb05c754";
const GRANDCHILD_TASK_ID = "a412f30077dfd84dd";

function launchedChild(projection: OrchestrationV2ThreadProjection) {
  const launched = projection.subagents.filter(
    (agent) => agent.parentNodeId === projection.runs[0]?.rootNodeId,
  );
  assert.lengthOf(launched, 1, "the root launched one subagent");
  return launched[0]!;
}

// Grandchild completion notifies its owning child; only that child's completion wakes the root.
export function assertNestedBackgroundSubagentWakeOutput(
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

  const child = launchedChild(projection);
  assert.equal(child.status, "completed");
  if (child.childThreadId === null) {
    throw new Error("The child subagent is missing its child thread.");
  }
  // Shown under the child: on the child's row in the root thread, or in the child's own thread.
  const grandchildren = [
    ...projection.subagents.filter((agent) => agent.parentNodeId === child.id),
    ...(result.projections.get(child.childThreadId)?.subagents ?? []),
  ];
  assert.lengthOf(grandchildren, 1, "the grandchild hangs off the child");
  assert.equal(grandchildren[0]?.status, "completed");

  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: `Subagent "${reportLabel(child.title ?? undefined)}" finished`,
      outcome: "completed",
      source: { kind: "subagent", childThreadId: child.childThreadId },
    },
  ]);
}

/** Claude's SDK names its tasks, nests the grandchild on the root thread, and wakes with the child's reply. */
export function assertClaudeNestedBackgroundSubagentWakeDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  const byTask = (taskId: string) => {
    const subagent = projection.subagents.find((agent) => agent.nativeTaskRef?.nativeId === taskId);
    assert.isDefined(subagent, `missing subagent for task ${taskId}`);
    assert.equal(subagent.status, "completed");
    return subagent;
  };
  const child = byTask(CHILD_TASK_ID);
  const grandchild = byTask(GRANDCHILD_TASK_ID);
  assert.equal(child.parentNodeId, projection.runs[0]?.rootNodeId);
  assert.equal(grandchild.parentNodeId, child.id, "the grandchild hangs off the child");

  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(wakeMessage?.text, "CHILD_DONE", "the child's end opens the wake");
  assert.deepEqual(
    backgroundNotifications(projection).map((notification) => notification.summary),
    [`Subagent "${child.title}" finished`],
  );
}
