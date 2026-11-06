import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { nestedSubagentLevels } from "./output.ts";

/** Codex's agent-path titles, and a provider thread with one turn behind every level. */
export function assertCodexSubagentV2NestedDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  let parentPath = "/root";
  for (const { subagent, projection } of nestedSubagentLevels(result, transcript).levels) {
    assert.equal(subagent.driver, "codex");
    assert.match(subagent.title ?? "", new RegExp(`^${parentPath}/[^/]+$`, "u"));
    assert.isNotNull(subagent.providerThreadId);
    assert.lengthOf(projection.providerTurns, 1);
    parentPath = subagent.title ?? "";
  }
}
