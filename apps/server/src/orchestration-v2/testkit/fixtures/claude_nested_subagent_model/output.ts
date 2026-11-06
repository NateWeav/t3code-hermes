import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { HERMES_NESTED_SUBAGENT_MODEL } from "../hermes_nested_subagent_model/input.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  forScenario,
  projectionFor,
} from "../shared.ts";

const OUTER_TASK_ID = "a457ca677bc1ecd82";
const NESTED_TASK_ID = "aac1d7a2af5371c7d";
/** The model each prompt asks the outer subagent to run on, as the provider reports it. */
const SUBAGENT_MODELS = {
  claude_nested_subagent_model: "claude-haiku-4-5",
  hermes_nested_subagent_model: HERMES_NESTED_SUBAGENT_MODEL,
};

/**
 * The subagent the root ran, and the one it ran in turn. A provider files the nested one under its
 * owner's node in the root thread, or in its owner's own thread.
 */
export function nestedSubagents(result: OrchestratorV2ScenarioResult, scenario: string) {
  const projection = projectionFor(result, scenario);
  const rootNodeId = projection.runs[0]?.rootNodeId;
  assert.isDefined(rootNodeId);
  const outer = projection.subagents.find((agent) => agent.parentNodeId === rootNodeId);
  assert.isDefined(outer, "missing the root's subagent");
  const outerThread =
    outer.childThreadId === null ? undefined : result.projections.get(outer.childThreadId);
  const holders = [projection, ...(outerThread === undefined ? [] : [outerThread])];
  const nested = holders
    .flatMap((holder) => holder.subagents)
    .find((agent) => agent.parentNodeId === outer.id || agent.threadId === outer.childThreadId);
  assert.isDefined(nested, "a nested subagent hangs off its owner");
  const holder = holders.find((candidate) => candidate.thread.id === nested.threadId);
  assert.isDefined(holder);
  return { projection, rootNodeId, outer, nested, holder };
}

export function assertNestedSubagentModelOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const { projection, outer, nested, holder } = nestedSubagents(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertAssistantTextIncludes(projection, "NESTED_LEAF_OK");
  assert.lengthOf(result.shellSnapshot.threads, 3);
  assert.equal(outer.status, "completed");
  assert.equal(nested.status, "completed");

  const subagentModel = forScenario(transcript, SUBAGENT_MODELS);
  assert.equal(outer.model, subagentModel);
  assert.equal(nested.model, subagentModel, "a nested subagent runs on its owner's model");
  assert.isDefined(holder.nodes.find((node) => node.id === nested.id));
  assert.include(nested.result ?? "", "NESTED_LEAF_OK");

  if (nested.childThreadId === null) {
    throw new Error("nested subagent is missing its child thread");
  }
  const nestedChild = result.projections.get(nested.childThreadId);
  assert.isDefined(nestedChild);
  assert.equal(nestedChild.thread.modelSelection.model, subagentModel);
}

/**
 * Claude's task ids, its selections on both subagents, the nested node under its owner's in the
 * root thread, and its result ledger, which counts only the root and adds both subagents once.
 */
export function assertClaudeNestedSubagentModelDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const { projection, rootNodeId, outer, nested } = nestedSubagents(result, transcript.scenario);
  assert.equal(outer.nativeTaskRef?.nativeId, OUTER_TASK_ID);
  assert.equal(nested.nativeTaskRef?.nativeId, NESTED_TASK_ID);
  const subagentSelection = {
    instanceId: outer.providerInstanceId,
    model: forScenario(transcript, SUBAGENT_MODELS),
  };
  assert.deepEqual(outer.modelSelection, subagentSelection);
  assert.deepEqual(nested.modelSelection, subagentSelection);
  const nestedNode = projection.nodes.find((node) => node.id === nested.id);
  assert.isDefined(nestedNode);
  assert.equal(nestedNode.parentNodeId, outer.id);
  assert.equal(nestedNode.rootNodeId, rootNodeId);
  assert.lengthOf(projection.providerTurns, 1);
  assert.deepInclude(projection.providerTurns[0]?.turnTokenUsage, {
    usageStatus: "complete",
    hasSubagents: true,
    inputTokens: 74_167,
    outputTokens: 236,
    reasoningTokens: 30,
    models: ["claude-sonnet-4-6"],
    otherUsage: { inputTokens: 87_409, outputTokens: 335 },
  });
}
