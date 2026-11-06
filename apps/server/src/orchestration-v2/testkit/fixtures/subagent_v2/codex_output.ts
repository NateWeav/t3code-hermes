import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";

/**
 * Codex's agent-path title and empty v2 prompt, the provider thread and turn behind the child, and
 * each agent's token counts on its own turn.
 */
export function assertCodexSubagentV2Details(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.driver, "codex");
  // Codex names v2 agents by path from the root; the model picks the leaf name.
  assert.match(subagent.title ?? "", /^\/root\/[^/]+$/u);
  assert.equal(subagent.prompt, "");
  assert.isNotNull(subagent.providerThreadId);

  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === subagent.providerThreadId,
  );
  assert.isDefined(providerThread);
  assert.equal(providerThread.appThreadId, subagent.childThreadId);
  assert.isNull(providerThread.ownerNodeId);

  assert.isNotNull(subagent.childThreadId);
  const childProjection = result.projections.get(subagent.childThreadId!);
  assert.isDefined(childProjection);
  assert.equal(childProjection.thread.activeProviderThreadId, providerThread.id);
  assert.lengthOf(childProjection.providerThreads, 1);
  assert.lengthOf(childProjection.providerTurns, 1);
  assert.equal(childProjection.providerTurns[0]?.status, "completed");

  // Only the root's model was reported.
  assert.deepInclude(projection.providerTurns[0]?.turnTokenUsage, {
    usageStatus: "complete",
    outputTokens: 69,
    models: ["gpt-6-luna"],
  });
  const childUsage = childProjection.providerTurns[0]?.turnTokenUsage;
  assert.deepInclude(childUsage, { usageStatus: "complete", outputTokens: 6 });
  assert.notProperty(childUsage, "models");
}
