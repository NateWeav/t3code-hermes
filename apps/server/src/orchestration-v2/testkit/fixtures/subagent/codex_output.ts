import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertTurnItemTypes, projectionFor } from "../shared.ts";

/** Codex's provider threads and turns per subagent, and the fixture workspace's file contents. */
export function assertCodexSubagentDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assert.equal(projection.runs.length, 1, "subagent provider turns must not become app runs");
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt.includes("package.json") &&
        !subagent.prompt.includes("tsconfig.json") &&
        subagent.result?.includes("effect-codex-app-server"),
    ),
  );
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt.includes("tsconfig.json") &&
        !subagent.prompt.includes("package.json") &&
        subagent.result?.includes("../../tsconfig.base.json"),
    ),
  );

  for (const subagent of projection.subagents) {
    assert.equal(subagent.driver, "codex");
    assert.isNotNull(subagent.providerThreadId);
    if (subagent.childThreadId === null) {
      throw new Error(`Subagent ${subagent.id} is missing its child thread`);
    }

    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === subagent.providerThreadId,
    );
    assert.isDefined(providerThread);
    assert.equal(providerThread.appThreadId, subagent.childThreadId);
    assert.isNull(providerThread.ownerNodeId);

    const childProjection = result.projections.get(subagent.childThreadId);
    assert.isDefined(childProjection);
    assert.equal(childProjection.thread.activeProviderThreadId, providerThread.id);
    assert.lengthOf(childProjection.providerThreads, 1);
    assert.lengthOf(childProjection.providerTurns, 1);
    assertTurnItemTypes(childProjection, [
      "user_message",
      "command_execution",
      "assistant_message",
    ]);
  }

  const rootProviderThread = projection.providerThreads.find(
    (thread) => thread.ownerNodeId === null && thread.appThreadId === projection.thread.id,
  );
  assert.isDefined(rootProviderThread);
  assert.equal(rootProviderThread.appThreadId, projection.thread.id);
  assert.equal(projection.thread.activeProviderThreadId, rootProviderThread.id);
}
