import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { projectedSubagentsToRuntime } from "./subagentRuntime.ts";

const base = {
  id: "node-subagent-1",
  title: "Review the parser",
  prompt: "Review the parser",
  model: "test/reviewer",
  status: "completed" as const,
  result: "Parser reviewed.",
  startedAt: DateTime.makeUnsafe("2026-09-21T12:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-09-21T12:00:10.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-09-21T12:00:10.000Z"),
};

describe("projectedSubagentsToRuntime", () => {
  it("carries a provider's role and usage onto the runtime agent", () => {
    const usage = {
      totalTokens: 12_400,
      inputTokens: 9_000,
      outputTokens: 3_400,
      durationMs: 2_500,
    };
    const [agent] = projectedSubagentsToRuntime([{ ...base, role: "leaf", usage }]);
    expect(agent).toMatchObject({ role: "leaf", model: "test/reviewer", usage });
  });

  it("leaves both empty for records that predate them", () => {
    const [agent] = projectedSubagentsToRuntime([base]);
    expect(agent).toMatchObject({ role: null, usage: null });
  });
});
