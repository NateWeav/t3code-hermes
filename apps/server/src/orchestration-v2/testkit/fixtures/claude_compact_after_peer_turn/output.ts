import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { HERMES_COMPACT_PEER_FIRST_PROMPT } from "../hermes_compact_after_peer_turn/input.ts";
import { HERMES_COMPACT_RESUME_FIRST_PROMPT } from "../hermes_compact_after_resume_wake/input.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "./input.ts";

const COMPACT_FIRST_REPLY = "compact probe first turn";

/** The first prompt and compaction command of each compaction scenario, by recorded scenario. */
const COMPACT_PROMPTS: Readonly<
  Record<string, { readonly first: string; readonly command: string }>
> = {
  claude_compact_after_peer_turn: { first: CLAUDE_COMPACT_FIRST_PROMPT, command: "/compact" },
  claude_compact_after_resume_wake: { first: CLAUDE_COMPACT_FIRST_PROMPT, command: "/compact" },
  hermes_compact_after_peer_turn: { first: HERMES_COMPACT_PEER_FIRST_PROMPT, command: "/compress" },
  hermes_compact_after_resume_wake: {
    first: HERMES_COMPACT_RESUME_FIRST_PROMPT,
    command: "/compress",
  },
};

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

/**
 * What every compaction scenario shows: the first prompt's run with its reply, and the compaction
 * command's own run carrying the one compaction, with the context size before and after it.
 */
export function assertCompactionRuns(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const prompts = COMPACT_PROMPTS[transcript.scenario];
  assert.isDefined(prompts, `no compaction prompts for ${transcript.scenario}`);
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const runs = claudeCompactRuns(projection);
  assert.deepEqual(
    runs.filter((run) => run.fromUser).map((run) => run.text),
    [prompts.first, prompts.command],
  );
  assert.deepEqual(
    runs.find((run) => run.text === prompts.first),
    {
      text: prompts.first,
      fromUser: true,
      status: "completed",
      replies: [COMPACT_FIRST_REPLY],
      compactions: [],
    },
  );
  const compaction = runs.find((run) => run.text === prompts.command);
  assert.equal(compaction?.status, "completed");
  assert.lengthOf(compaction?.compactions ?? [], 1);
  const [before, after] = compaction?.compactions[0] ?? [];
  assert.isAbove(before ?? 0, 0);
  assert.isAbove(after ?? 0, 0);
  return runs;
}

// A peer-origin turn runs before the compaction: it settles as its own run, without the compaction.
export function assertCompactAfterPeerTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const runs = assertCompactionRuns(result, transcript);
  assert.lengthOf(runs, 3);
  assert.deepEqual(
    runs
      .filter((run) => !run.fromUser)
      .map(({ status, replies, compactions }) => ({ status, replies, compactions })),
    [{ status: "completed", replies: ["PEER_ACK"], compactions: [] }],
  );
}

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
      replies: [COMPACT_FIRST_REPLY],
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
