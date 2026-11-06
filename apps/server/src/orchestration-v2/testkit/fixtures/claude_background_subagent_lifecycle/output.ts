import { assert } from "@effect/vitest";
import type {
  OrchestrationV2ThreadProjection,
  ProviderReplayTranscript,
  ThreadId,
} from "@t3tools/contracts";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT,
  HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
  HERMES_LIFECYCLE_AGENT_A_MODEL,
} from "../hermes_background_subagent_lifecycle/input.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  forScenario,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "./input.ts";

const AGENT_A_TASK_ID = "a1a715b7d0bdfefea";
const AGENT_B_TASK_ID = "af44d5c14aa3ce867";
const PROMPTS = {
  claude_background_subagent_lifecycle: [
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  ],
  hermes_background_subagent_lifecycle: [
    HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT,
    HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
    HERMES_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  ],
};
/** The model each prompt asks Agent A to run on, as the provider reports it. */
const AGENT_A_MODELS = {
  claude_background_subagent_lifecycle: "claude-haiku-4-5",
  hermes_background_subagent_lifecycle: HERMES_LIFECYCLE_AGENT_A_MODEL,
};
const AGENT_A_FIRST_PROMPT = "Reply with exactly: A_FIRST";

function assistantTexts(
  projection: OrchestrationV2ThreadProjection,
  runId?: string,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" && (runId === undefined || item.runId === runId)
      ? [item.text.trim()]
      : [],
  );
}

function conversation(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .flatMap((item) =>
      item.type === "user_message"
        ? [`user:${item.text.trim()}`]
        : item.type === "assistant_message"
          ? [`assistant:${item.text.trim()}`]
          : [],
    );
}

export function frameField(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, key) : undefined;
}

function sendMessageToolUseIds(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    const content = frameField(
      frameField(entry.type === "emit_inbound" ? entry.frame : undefined, "message"),
      "content",
    );
    return Array.isArray(content)
      ? content.flatMap((part) =>
          frameField(part, "type") === "tool_use" && frameField(part, "name") === "SendMessage"
            ? [String(frameField(part, "id"))]
            : [],
        )
      : [];
  });
}

// SendMessage resumes reusing task ids, with task_started under its own tool_use_id.
function assertRecordedResumeShape(transcript: ProviderReplayTranscript) {
  const agentAStarts = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" &&
    frameField(entry.frame, "subtype") === "task_started" &&
    frameField(entry.frame, "task_id") === AGENT_A_TASK_ID
      ? [String(frameField(entry.frame, "tool_use_id"))]
      : [],
  );
  assert.lengthOf(agentAStarts, 2, "SendMessage must re-emit task_started for Agent A");
  assert.deepEqual(agentAStarts.slice(1), sendMessageToolUseIds(transcript));
}

function thinkingOf(child: OrchestrationV2ThreadProjection | undefined) {
  return (child?.turnItems ?? []).flatMap((item) =>
    item.type === "reasoning" && item.title === "Thinking" ? [item] : [],
  );
}

/** Agent A is the subagent whose thread starts with its first prompt; Agent B is the other. */
export function lifecycleAgents(result: OrchestratorV2ScenarioResult, scenario: string) {
  const projection = projectionFor(result, scenario);
  const childOf = (childThreadId: ThreadId | null | undefined) =>
    childThreadId == null ? undefined : result.projections.get(childThreadId);
  const agentA = projection.subagents.find(
    (subagent) =>
      conversation(childOf(subagent.childThreadId) ?? projection)[0] ===
      `user:${AGENT_A_FIRST_PROMPT}`,
  );
  const agentB = projection.subagents.find((subagent) => subagent !== agentA);
  return {
    projection,
    agentA,
    agentB,
    agentAChild: childOf(agentA?.childThreadId),
    agentBChild: childOf(agentB?.childThreadId),
  };
}

export function assertBackgroundSubagentLifecycleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 7,
    runStatuses: Array.from({ length: 7 }, () => "completed" as const),
  });
  const { projection, agentA, agentB, agentAChild, agentBChild } = lifecycleAgents(
    result,
    transcript.scenario,
  );
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, forScenario(transcript, PROMPTS));

  const creators = projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return `${message?.createdBy}:${message?.creationSource}`;
  });
  assert.deepEqual(creators, [
    "user:web",
    "agent:provider",
    "user:web",
    "agent:provider",
    "user:web",
    "agent:provider",
    "user:web",
  ]);
  const runTexts = projection.runs.map((run) => assistantTexts(projection, run.id));
  assert.deepEqual(runTexts[0], ["LAUNCHED"]);
  assert.deepEqual(runTexts[1], ["A_REPORTED"]);
  assert.deepEqual(runTexts[2], ["B_STOPPED"]);
  assert.lengthOf(runTexts[3] ?? [], 1, "the stop notification wakes the root once");
  assert.deepEqual(runTexts[4], ["RESUMED"]);
  assert.deepEqual(runTexts[5], ["A_RESUME_REPORTED"]);
  assert.deepEqual(runTexts[6], ["ALL_DONE"]);
  for (const text of ["A_FIRST", "A_SECOND"]) {
    assert.notInclude(assistantTexts(projection), text, `${text} leaked into the parent thread`);
  }

  assert.lengthOf(projection.subagents, 2);
  assert.isDefined(agentA, "Agent A's thread starts with its first prompt");
  assert.isDefined(agentB);
  assert.include(["cancelled", "interrupted"], agentB.status, "Agent B was stopped");
  assert.equal(agentA.status, "completed");
  const agentWake = (
    subagent: { readonly title: string | null; readonly childThreadId: ThreadId | null },
    outcome: "completed" | "cancelled",
  ) => ({
    summary: `Subagent "${reportLabel(subagent.title ?? undefined)}" ${outcome === "completed" ? "finished" : "was stopped"}`,
    outcome,
    source:
      subagent.childThreadId == null
        ? { kind: "subagent" as const }
        : { kind: "subagent" as const, childThreadId: subagent.childThreadId },
  });
  assert.deepEqual(backgroundNotifications(projection), [
    agentWake(agentA, "completed"),
    agentWake(agentB, "cancelled"),
    agentWake(agentA, "completed"),
  ]);
  assert.equal(agentA.result, "A_SECOND");
  const agentAModel = forScenario(transcript, AGENT_A_MODELS);
  assert.equal(agentA.model, agentAModel);
  assert.equal(agentA.runId, projection.runs[4]?.id);

  const agentAStatuses = result.domainEvents.flatMap((event) =>
    event.type === "subagent.updated" && event.payload.id === agentA.id
      ? [event.payload.status]
      : [],
  );
  const firstCompleted = agentAStatuses.indexOf("completed");
  assert.isAtLeast(firstCompleted, 0);
  assert.isAbove(agentAStatuses.lastIndexOf("running"), firstCompleted);
  assert.equal(agentAStatuses.at(-1), "completed");

  assert.isDefined(agentAChild);
  assert.equal(agentAChild.thread.modelSelection.model, agentAModel);
  assert.deepEqual(assistantTexts(agentAChild), ["A_FIRST", "A_SECOND"]);
  assert.deepEqual(conversation(agentAChild), [
    `user:${AGENT_A_FIRST_PROMPT}`,
    "assistant:A_FIRST",
    "user:Reply with exactly: A_SECOND",
    "assistant:A_SECOND",
  ]);

  const subagentThinking = new Set(
    [...thinkingOf(agentAChild), ...thinkingOf(agentBChild)].map((item) => item.text),
  );
  assert.isFalse(
    thinkingOf(projection).some((item) => subagentThinking.has(item.text)),
    "subagent thinking leaked into the parent thread",
  );
  for (const child of [agentAChild, agentBChild]) {
    for (const item of child?.turnItems ?? []) {
      assert.notInclude(["pending", "running", "waiting"], item.status, item.id);
      assert.isFalse(
        item.type === "reasoning" && item.title !== "Thinking",
        `${item.id} is not the subagent's own thinking`,
      );
    }
  }

  assert.isFalse(
    result.domainEvents.some(
      (event) =>
        event.type === "provider-thread.updated" &&
        (event.payload.pendingBackgroundTasks?.length ?? 0) > 0,
    ),
  );
}

/**
 * Claude's SDK resumes Agent A under SendMessage's tool_use_id, names the agents by description,
 * stops B as `cancelled`, reports its Bash progress, and streams each run's thinking into the
 * child threads.
 */
export function assertClaudeBackgroundSubagentLifecycleDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertRecordedResumeShape(transcript);
  const { agentA, agentB, agentAChild, agentBChild } = lifecycleAgents(result, transcript.scenario);
  assert.equal(agentA?.nativeTaskRef?.nativeId, AGENT_A_TASK_ID);
  assert.equal(agentB?.nativeTaskRef?.nativeId, AGENT_B_TASK_ID);
  assert.equal(agentA?.title, "Agent A");
  assert.equal(agentB?.title, "Agent B");
  assert.equal(agentB?.status, "cancelled");

  const agentAThinking = thinkingOf(agentAChild);
  assert.lengthOf(agentAThinking, 2, "both of Agent A's runs thought before replying");
  assert.include(agentAThinking[0]?.text, '"A_FIRST"');
  assert.include(agentAThinking[1]?.text, '"A_SECOND"');
  for (const item of agentAThinking) {
    assert.equal(item.status, "completed");
    assert.isFalse(item.streaming);
    assert.isNull(item.runId);
  }
  const agentAOrder = (agentAChild?.turnItems ?? []).flatMap((item) =>
    item.type === "assistant_message"
      ? [item.text.trim()]
      : item.type === "reasoning" && item.title === "Thinking"
        ? ["thinking"]
        : [],
  );
  assert.deepEqual(agentAOrder, ["thinking", "A_FIRST", "thinking", "A_SECOND"]);
  assert.lengthOf(thinkingOf(agentBChild), 1);
  assert.include(thinkingOf(agentBChild)[0]?.text, "B_DONE");
  assert.equal(agentB?.progress, "Running Wait 90 seconds then print B_DONE");
}
