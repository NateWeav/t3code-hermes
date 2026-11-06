import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";

/** Codex v2 children request on their own native turns, which their thread shows. */
export function assertCodexSubagentV2ApprovalDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const subagent = projectionFor(result, transcript.scenario).subagents[0]!;
  const child = result.projections.get(subagent.childThreadId!);
  assert.isDefined(child);
  const command = child.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
}
