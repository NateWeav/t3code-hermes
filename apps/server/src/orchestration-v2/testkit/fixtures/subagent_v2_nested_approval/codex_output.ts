import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";

/** Codex v2 grandchildren run the command on their own native turn, which their thread shows. */
export function assertCodexSubagentV2NestedApprovalDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const child = projectionFor(result, transcript.scenario).subagents[0]!;
  const grandchild = result.projections.get(child.childThreadId!)?.subagents[0];
  assert.isDefined(grandchild);
  const grandchildProjection = result.projections.get(grandchild.childThreadId!);
  assert.isDefined(grandchildProjection);
  const command = grandchildProjection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
}
