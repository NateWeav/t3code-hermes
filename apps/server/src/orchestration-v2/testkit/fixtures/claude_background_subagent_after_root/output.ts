import { assert } from "@effect/vitest";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ProviderReplayTranscript,
} from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { HERMES_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "../hermes_background_subagent_after_root/input.ts";
import {
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  forScenario,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./input.ts";

const PROMPTS = {
  claude_background_subagent_after_root: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
  hermes_background_subagent_after_root: HERMES_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
};
const FINAL_REPORT = "SUB_FINAL_REPORT";
const SUBAGENT_TEXTS = ["SUB_STEP_1", "SUB_STEP_2", FINAL_REPORT];
const SUBAGENT_COMMANDS = ["sleep 3 && echo SUB_DONE_1", "sleep 3 && echo SUB_DONE_2"];
const SUBAGENT_PROGRESS = [
  "Running Sleep 3 seconds then echo SUB_DONE_1",
  "Running Sleep 3 seconds then echo SUB_DONE_2",
];

function assistantTexts(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

function commandTexts(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "command_execution" ? [JSON.stringify(item.input)] : [],
  );
}

function backgroundSubagent(result: OrchestratorV2ScenarioResult, scenario: string) {
  const projection = projectionFor(result, scenario);
  const subagent = projection.subagents[0];
  if (subagent?.childThreadId == null) {
    throw new Error("The background subagent is missing its child thread.");
  }
  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  // A Hermes gateway turn is already streaming when its run opens, so it has no `starting` status.
  const continuationStartIndex = result.domainEvents.findIndex(
    (event) => event.type === "run.updated" && event.payload.id === projection.runs[1]?.id,
  );
  assert.isAtLeast(continuationStartIndex, 0);
  const assertStoredWhileIdle = (
    label: string,
    matches: (event: OrchestrationV2DomainEvent) => boolean,
  ) => {
    const index = result.domainEvents.findIndex(matches);
    assert.isAtLeast(index, 0, `${label} is stored`);
    assert.isBelow(index, continuationStartIndex, `${label} is stored before the root wakes`);
  };
  const childText = (text: string) => (event: OrchestrationV2DomainEvent) =>
    event.type === "message.updated" &&
    event.payload.threadId === subagent.childThreadId &&
    event.payload.text.trim() === text;
  return {
    projection,
    subagent,
    childThreadId: subagent.childThreadId,
    childProjection,
    continuationStartIndex,
    assertStoredWhileIdle,
    childText,
  };
}

export function assertBackgroundSubagentAfterRootOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [forScenario(transcript, PROMPTS)]);

  const parentTexts = assistantTexts(projection);
  assert.includeMembers([...parentTexts], ["ROOT_STARTED", "ROOT_WAKE_DONE"]);
  for (const text of SUBAGENT_TEXTS) {
    assert.notInclude(parentTexts, text, `subagent text ${text} leaked into the parent thread`);
  }
  for (const command of SUBAGENT_COMMANDS) {
    assert.isFalse(
      commandTexts(projection).some((input) => input.includes(command)),
      `subagent command ${command} leaked into the parent thread`,
    );
  }

  assert.lengthOf(projection.subagents, 1);
  assert.lengthOf(projection.runs, 2);
  const {
    subagent,
    childThreadId,
    childProjection,
    continuationStartIndex,
    assertStoredWhileIdle,
    childText,
  } = backgroundSubagent(result, transcript.scenario);
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.runId, projection.runs[0]?.id);
  const subagentNode = projection.nodes.find((node) => node.id === subagent.id);
  assert.equal(subagentNode?.status, "completed");
  assert.equal(subagentNode?.runId, projection.runs[0]?.id);
  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.isFalse(
    result.domainEvents.some(
      (event) =>
        event.type === "provider-thread.updated" &&
        (event.payload.pendingBackgroundTasks?.length ?? 0) > 0,
    ),
  );
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: `Subagent "${reportLabel(subagent.title ?? undefined)}" finished`,
      outcome: "completed",
      source: { kind: "subagent", childThreadId },
    },
  ]);

  const childReports = assistantTexts(childProjection).filter((text) =>
    SUBAGENT_TEXTS.includes(text),
  );
  assert.equal(childReports.at(-1), FINAL_REPORT, "the child thread ends with its final report");
  assert.lengthOf(
    childReports.filter((text) => text === FINAL_REPORT),
    1,
    "the child thread shows its final report once",
  );
  assertStoredWhileIdle("the subagent's final report", childText(FINAL_REPORT));
  assert.isFalse(
    result.domainEvents
      .slice(continuationStartIndex)
      .some(
        (event) =>
          (event.type === "message.updated" || event.type === "turn-item.updated") &&
          event.payload.threadId === childThreadId,
      ),
    "the continuation run stores none of the subagent's work",
  );
}

/** Claude's SDK streams the child's narration and commands, and wakes with its final report. */
export function assertClaudeBackgroundSubagentAfterRootDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const {
    projection,
    subagent,
    childThreadId,
    childProjection,
    continuationStartIndex,
    assertStoredWhileIdle,
    childText,
  } = backgroundSubagent(result, transcript.scenario);
  const continuationStart = result.domainEvents[continuationStartIndex];
  assert.equal(
    continuationStart?.type === "run.updated" && continuationStart.payload.status,
    "starting",
  );
  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(wakeMessage?.text, FINAL_REPORT);
  assert.equal(subagent.title, "Background subagent test");
  assert.deepEqual(
    assistantTexts(childProjection).filter((text) => SUBAGENT_TEXTS.includes(text)),
    SUBAGENT_TEXTS,
    "the child thread shows the subagent's narration in order and its final report once",
  );
  for (const command of SUBAGENT_COMMANDS) {
    assert.isTrue(
      commandTexts(childProjection).some((input) => input.includes(command)),
      `subagent command ${command} must be in the child thread`,
    );
  }
  for (const text of SUBAGENT_TEXTS) {
    assertStoredWhileIdle(`subagent text ${text}`, childText(text));
  }
  for (const command of SUBAGENT_COMMANDS) {
    assertStoredWhileIdle(
      `completed subagent command ${command}`,
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.threadId === childThreadId &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed" &&
        event.payload.input.includes(command),
    );
  }
  for (const progress of SUBAGENT_PROGRESS) {
    assertStoredWhileIdle(
      `subagent progress "${progress}"`,
      (event) =>
        event.type === "subagent.updated" &&
        event.payload.id === subagent.id &&
        event.payload.progress === progress,
    );
  }
}
