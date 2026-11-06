import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  HERMES_COMPACT_PEER_FIRST_PROMPT,
  HERMES_COMPACT_PEER_WAKE_PROMPT,
} from "../hermes_compact_after_peer_turn/input.ts";
import { HERMES_COMPACT_WAKE_PROMPT } from "../hermes_compact_after_resume_wake/input.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "./input.ts";

export function claudeCompactRuns(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    const items = projection.turnItems.filter((item) => item.runId === run.id);
    return {
      text: message?.text,
      fromUser: message?.createdBy === "user",
      status: run.status,
      replies: items.flatMap((item) =>
        item.type === "assistant_message" ? [item.text.trim()] : [],
      ),
      compactions: items.flatMap((item) =>
        item.type === "compaction" ? [[item.beforeTokenCount, item.afterTokenCount]] : [],
      ),
    };
  });
}

interface CompactionScenario {
  /** The user's messages before the compaction command, each with its last reply. */
  readonly turns: ReadonlyArray<readonly [prompt: string, reply: string]>;
  readonly compactCommand: string;
  /** The reply to the turn the user did not send: a peer's message or a background wake. */
  readonly unpromptedReply: string;
}

const COMPACTION_SCENARIOS: Readonly<Record<string, CompactionScenario>> = {
  claude_compact_after_peer_turn: {
    turns: [[CLAUDE_COMPACT_FIRST_PROMPT, "compact probe first turn"]],
    compactCommand: "/compact",
    unpromptedReply: "PEER_ACK",
  },
  hermes_compact_after_peer_turn: {
    turns: [
      [HERMES_COMPACT_PEER_FIRST_PROMPT, "compact probe first turn"],
      [HERMES_COMPACT_PEER_WAKE_PROMPT, "STARTED"],
    ],
    compactCommand: "/compress",
    unpromptedReply: "WAKE_DONE",
  },
  claude_compact_after_resume_wake: {
    turns: [[CLAUDE_COMPACT_FIRST_PROMPT, "compact probe first turn"]],
    compactCommand: "/compact",
    unpromptedReply: "A_REPORTED",
  },
  hermes_compact_after_resume_wake: {
    turns: [[HERMES_COMPACT_WAKE_PROMPT, "STARTED"]],
    compactCommand: "/compress",
    unpromptedReply: "WAKE_DONE",
  },
};

/** Every run completes, the user's turns get their replies, and only the command's run compacts. */
function assertCompactionRuns(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const scenario = COMPACTION_SCENARIOS[transcript.scenario];
  assert.isDefined(scenario, `no compaction contract for ${transcript.scenario}`);
  const { turns, compactCommand, unpromptedReply } = scenario!;
  const runs = claudeCompactRuns(projection);
  assert.deepEqual(
    runs.map((run) => run.status),
    runs.map(() => "completed"),
  );
  const userRuns = runs.filter((run) => run.fromUser);
  assert.deepEqual(
    userRuns.map((run) => run.text),
    [...turns.map(([prompt]) => prompt), compactCommand],
  );
  assert.deepEqual(
    userRuns.slice(0, -1).map((run) => run.replies.at(-1)),
    turns.map(([, reply]) => reply),
  );
  const compactRun = userRuns.at(-1)!;
  assert.deepEqual(
    runs.filter((run) => run.compactions.length > 0),
    [compactRun],
  );
  assert.lengthOf(compactRun.compactions, 1);
  const [before, after] = compactRun.compactions[0]!;
  assert.isNumber(before);
  assert.isNumber(after);
  assert.isAbove(before!, after!);
  return { runs, compactRun, unpromptedReply };
}

/**
 * A turn the user did not send arrives after the compaction command: it shows as its own run with
 * its reply, and the compaction still completes on the command's run without taking that reply.
 */
export function assertCompactAfterPeerTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const { runs, compactRun, unpromptedReply } = assertCompactionRuns(result, transcript);
  const unprompted = runs.filter((run) => !run.fromUser);
  assert.lengthOf(unprompted, 1);
  assert.equal(unprompted[0]!.replies.at(-1), unpromptedReply);
  assert.isAbove(runs.indexOf(unprompted[0]!), runs.indexOf(compactRun));
  assert.notInclude(compactRun.replies, unpromptedReply);
}

/**
 * A resumed session's background wake is shown once, no later than the compaction, and does not
 * settle the compaction command early.
 */
export function assertCompactAfterResumeWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const { runs, compactRun, unpromptedReply } = assertCompactionRuns(result, transcript);
  assert.lengthOf(
    runs.flatMap((run) => run.replies).filter((reply) => reply === unpromptedReply),
    1,
  );
  const wakeRun = runs.findIndex((run) => run.replies.includes(unpromptedReply));
  assert.isAtMost(wakeRun, runs.indexOf(compactRun));
  assert.isTrue(runs.slice(runs.indexOf(compactRun) + 1).every((run) => run.fromUser));
}

/** Claude's recorded token counts and usage ledger, and the peer turn spliced into its frames. */
export function assertClaudeCompactAfterPeerTurnDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  const runs = claudeCompactRuns(projection);
  assert.deepEqual(runs.slice(0, 2), [
    {
      text: CLAUDE_COMPACT_FIRST_PROMPT,
      fromUser: true,
      status: "completed",
      replies: ["compact probe first turn"],
      compactions: [],
    },
    {
      text: "/compact",
      fromUser: true,
      status: "completed",
      replies: [],
      compactions: [[27445, 1192]],
    },
  ]);
  assert.lengthOf(runs, 3);
  assert.isFalse(runs[2]?.fromUser);
  assert.equal(runs[2]?.status, "completed");
  assert.deepEqual(runs[2]?.replies, ["PEER_ACK"]);
  assert.deepEqual(runs[2]?.compactions, []);

  const usage = projection.runs.map(
    (run) =>
      projection.providerTurns.find((turn) => turn.runAttemptId === run.activeAttemptId)
        ?.turnTokenUsage,
  );
  assert.deepInclude(usage[0], {
    outputTokens: 7,
    otherUsage: { inputTokens: 1015, outputTokens: 12 },
  });
  // /compact reports zero tokens as a local command.
  assert.deepInclude(usage[1], {
    usageStatus: "complete",
    inputTokens: 0,
    outputTokens: 0,
    localCommand: true,
  });
  // The peer result's ledger is empty, so neither it nor the next result has a baseline.
  assert.deepInclude(usage[2], { usageStatus: "complete", outputTokens: 4 });
  assert.notProperty(usage[1], "otherUsage");
  assert.notProperty(usage[2], "otherUsage");
}
