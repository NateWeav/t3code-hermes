import { assert } from "@effect/vitest";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ProviderReplayTranscript,
} from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertRunProviderTurnCardinality,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_NESTED_PROMPT,
} from "../shared.ts";

export interface NestedLevel {
  readonly subagent: OrchestrationV2Subagent;
  /** The thread the subagent runs in, which holds its own subagent one level down. */
  readonly projection: OrchestrationV2ThreadProjection;
}

/** The root thread, then each level's subagent with the thread it runs in, outermost first. */
export function nestedSubagentLevels(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
): {
  readonly root: OrchestrationV2ThreadProjection;
  readonly levels: ReadonlyArray<NestedLevel>;
} {
  const root = projectionFor(result, transcript.scenario);
  const levels: Array<NestedLevel> = [];
  let parent = root;
  for (let depth = 0; depth < 3; depth++) {
    const subagent = parent.subagents[0];
    if (subagent === undefined || subagent.childThreadId === null) {
      throw new Error(`level ${depth + 1} subagent is missing its child thread`);
    }
    const projection = result.projections.get(subagent.childThreadId);
    assert.isDefined(projection, `missing projection for ${subagent.childThreadId}`);
    levels.push({ subagent, projection });
    parent = projection;
  }
  return { root, levels };
}

/** Three levels of subagents, each launched by the one above and answering it inside the root run. */
export function assertSubagentV2NestedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const rootProjection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(rootProjection);
  assertTurnItemTypes(rootProjection, ["user_message", "subagent", "assistant_message"]);
  assertRunProviderTurnCardinality({ projection: rootProjection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection: rootProjection, expectedAppRuns: 1 });
  assertUserMessagesInclude(rootProjection, [SUBAGENT_V2_NESTED_PROMPT]);
  assert.lengthOf(result.shellSnapshot.threads, 4);

  let parent = rootProjection;
  for (const [depth, { subagent, projection }] of nestedSubagentLevels(
    result,
    transcript,
  ).levels.entries()) {
    assert.lengthOf(parent.subagents, 1);
    assert.lengthOf(
      parent.turnItems.filter((item) => item.type === "subagent"),
      1,
      `${parent.thread.id} must only render its direct subagent`,
    );
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.createdBy, "agent");
    assert.equal(subagent.status, "completed");
    assert.equal(subagent.result, "Hello.");
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.completedAt);

    assert.equal(projection.thread.lineage.parentThreadId, parent.thread.id);
    assert.equal(projection.thread.lineage.relationshipToParent, "subagent");
    assert.equal(projection.thread.lineage.rootThreadId, rootProjection.thread.id);
    assert.lengthOf(projection.runs, 0);
    if (depth < 2) {
      assertTurnItemTypes(projection, ["subagent", "assistant_message"]);
    } else {
      assert.lengthOf(projection.subagents, 0);
      assertTurnItemTypes(projection, ["assistant_message"]);
      assert.isTrue(
        projection.turnItems.some(
          (item) => item.type === "assistant_message" && item.text === "Hello.",
        ),
        "leaf child thread must contain the final assistant message",
      );
    }
    parent = projection;
  }
}
