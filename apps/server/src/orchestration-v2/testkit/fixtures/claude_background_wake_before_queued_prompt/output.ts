import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  forScenario,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "../claude_background_subagent_lifecycle/input.ts";
import {
  HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT,
  HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_RESUME_PROMPT,
  HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_STOP_PROMPT,
} from "../hermes_background_wake_before_queued_prompt/input.ts";
import { CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT } from "./input.ts";

const PROMPTS = {
  claude_background_wake_before_queued_prompt: [
    CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  ],
  hermes_background_wake_before_queued_prompt: [
    HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT,
    HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_STOP_PROMPT,
    HERMES_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_RESUME_PROMPT,
    CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  ],
};

const STOP_WAKE_REPLY =
  "Agent B's kill is confirmed by the notification. No further action needed — the task is complete.";

function frameField(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, key) : undefined;
}

// A CLI wake can precede the offered prompt's turn; only the latter echoes its uuid.
function assertRecordedWakeBeforePrompt(transcript: ProviderReplayTranscript) {
  const resumeOfferIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "prompt.offer:3",
  );
  const resumeOffer = transcript.entries[resumeOfferIndex];
  const resumeUuid = frameField(
    frameField(resumeOffer?.type === "expect_outbound" ? resumeOffer.frame : undefined, "message"),
    "uuid",
  );
  assert.isString(resumeUuid, "the resume prompt must carry a uuid");
  const resultsAfterOffer = transcript.entries
    .slice(resumeOfferIndex + 1)
    .flatMap((entry) =>
      entry.type === "emit_inbound" && frameField(entry.frame, "type") === "result"
        ? [entry.frame]
        : [],
    );
  const [wakeResult, promptResult] = resultsAfterOffer;
  assert.equal(frameField(frameField(wakeResult, "origin"), "kind"), "task-notification");
  assert.isUndefined(frameField(wakeResult, "user_message_uuid"));
  assert.equal(frameField(promptResult, "user_message_uuid"), resumeUuid);
}

function repliesByMessage(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    const items = projection.turnItems.filter((item) => item.runId === run.id);
    return {
      fromUser: message?.createdBy === "user",
      text: message?.text,
      replies: items.flatMap((item) =>
        item.type === "assistant_message" ? [item.text.trim()] : [],
      ),
      notifications: items.flatMap((item) => (item.type === "notification" ? [item] : [])),
    };
  });
}

function subagentLabel(projection: OrchestrationV2ThreadProjection, marker: RegExp) {
  const subagent = projection.subagents.find((candidate) => marker.test(candidate.prompt));
  assert.isDefined(subagent, `no subagent's prompt matches ${marker}`);
  return reportLabel(subagent.title ?? undefined);
}

export function assertBackgroundWakeBeforeQueuedPromptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const runs = repliesByMessage(projection);
  const [launch, stop, resume, final] = forScenario(transcript, PROMPTS);

  // A wake the provider runs ahead of a queued prompt is a run of its own, never part of that prompt's.
  const userReplies = runs.filter((run) => run.fromUser).map((run) => [run.text, run.replies]);
  assert.deepEqual(userReplies, [
    [launch, ["LAUNCHED"]],
    [stop, ["B_STOPPED"]],
    [resume, ["RESUMED"]],
    [final, ["ALL_DONE"]],
  ]);
  assert.isTrue(projection.runs.every((run) => run.status === "completed"));

  const wakes = runs.filter((run) => !run.fromUser);
  // A resumed subagent's prompt is the message that resumed it.
  const agentA = subagentLabel(projection, /\bA_(FIRST|SECOND)\b/);
  const agentB = subagentLabel(projection, /\bB_DONE\b/);
  const aWake = wakes.find((run) =>
    run.notifications.some(
      ({ summary, source }) =>
        summary === `Subagent "${agentA}" finished` && source.kind === "subagent",
    ),
  );
  assert.deepEqual(aWake?.replies, ["A_REPORTED"], "Agent A's wake run replies A_REPORTED");
  const stopWake = wakes.find((run) =>
    run.notifications.some(
      ({ summary }) => summary.startsWith(`Subagent "${agentB}"`) && summary.endsWith("stopped"),
    ),
  );
  assert.isDefined(stopWake, "a wake run names Agent B's stop");
  assert.isNotEmpty(stopWake.replies, "the stop wake's reply shows in its own run");
}

/** Claude's CLI echoes the resume prompt's uuid only on its own result, and words the wakes its way. */
export function assertClaudeBackgroundWakeBeforeQueuedPromptDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertRecordedWakeBeforePrompt(transcript);
  const projection = projectionFor(result, transcript.scenario);
  const continuationReplies = repliesByMessage(projection)
    .filter((run) => !run.fromUser)
    .flatMap((run) => run.replies);
  assert.sameMembers(continuationReplies, ["A_REPORTED", STOP_WAKE_REPLY]);
  assert.deepEqual(
    backgroundNotifications(projection).map(({ summary, source }) => [summary, source.kind]),
    [
      ['Subagent "Agent A" finished', "subagent"],
      [
        'Subagent "Agent B" and command "Sleep 60 seconds then echo B_DONE" were stopped',
        "background_task",
      ],
    ],
  );
}
