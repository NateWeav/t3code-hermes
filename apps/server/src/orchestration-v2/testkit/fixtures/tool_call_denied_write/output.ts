import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";

/**
 * Any provider: the one write asks, the user declines, the write fails and is not retried. Each
 * variant's details check its own prompt wording, which a twin changes.
 */
export function assertToolCallDeniedWriteOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "user_message"),
    1,
  );
  assertAssistantTextIncludes(projection, "write permission denied");

  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.decision),
    ["decline"],
  );

  const writes = projection.turnItems.filter((item) => item.type === "file_change");
  assert.lengthOf(writes, 1);
  assert.equal(writes[0]?.status, "failed");
}
