import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertNoExtraAppRunsForProviderChildren,
  assertRunProviderTurnCardinality,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_PROMPT,
} from "../shared.ts";

/** Two subagents run and answer inside the parent's one run, each in its own thread. */
export function assertSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "subagent"]);
  assertTurnItemTypes(projection, ["user_message", "subagent", "assistant_message"]);
  assertRunProviderTurnCardinality({ projection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assert.lengthOf(
    projection.turnItems.filter(
      (item) => item.type === "dynamic_tool" || item.type === "command_execution",
    ),
    0,
    "subagent tools must not be projected into the parent thread",
  );

  assert.deepEqual(
    projection.nodes.filter((node) => node.kind === "subagent").map((node) => node.status),
    ["completed", "completed"],
  );
  assert.lengthOf(projection.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed", "completed"],
  );
  for (const [file, other] of [
    ["package.json", "tsconfig.json"],
    ["tsconfig.json", "package.json"],
  ] as const) {
    assert.isTrue(
      projection.subagents.some(
        (subagent) =>
          subagent.prompt.includes(file) &&
          !subagent.prompt.includes(other) &&
          (subagent.result ?? "").trim().length > 0,
      ),
      `one subagent must read only ${file} and answer`,
    );
  }

  for (const subagent of projection.subagents) {
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.createdBy, "agent");
    assert.isNotNull(subagent.childThreadId);
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.completedAt);
    const parentItem = projection.turnItems.find(
      (item) => item.type === "subagent" && item.subagentId === subagent.id,
    );
    if (parentItem?.type !== "subagent") {
      throw new Error(`Missing parent lifecycle item for subagent ${subagent.id}`);
    }
    assert.equal(parentItem.result, subagent.result);
    if (subagent.childThreadId === null) {
      throw new Error(`Subagent ${subagent.id} is missing its child thread`);
    }

    const childProjection = result.projections.get(subagent.childThreadId);
    assert.isDefined(childProjection);
    assert.equal(childProjection.thread.lineage.parentThreadId, projection.thread.id);
    assert.equal(childProjection.thread.lineage.relationshipToParent, "subagent");
    assert.lengthOf(childProjection.runs, 0);
    assertTurnItemTypes(childProjection, ["user_message", "assistant_message"]);
    assertUserMessagesInclude(childProjection, [subagent.prompt]);
    assert.isTrue(
      childProjection.turnItems.some(
        (item) =>
          item.type === "assistant_message" &&
          subagent.result !== null &&
          item.text.includes(subagent.result.slice(0, 40)),
      ),
      `child thread ${subagent.childThreadId} must contain the subagent response`,
    );
  }
}
