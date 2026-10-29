import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentElapsedMs } from "./orchestrationTiming.ts";

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
  it("prefers a settled task's reported duration over its observed window", () => {
    const usage = { totalTokens: 1_200, durationMs: 2_500 };
    expect(
      deriveSubagentElapsedMs({ status: "completed", startedAt, completedAt, usage }, now),
    ).toBe(2_500);
    expect(
      deriveSubagentElapsedMs({ status: "failed", startedAt: null, completedAt: null, usage }, now),
    ).toBe(2_500);
    // Live work keeps ticking, and token-only usage leaves the window alone.
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt, usage }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs(
        { status: "completed", startedAt, completedAt, usage: { totalTokens: 1_200 } },
        now,
      ),
    ).toBe(10_000);
  });
});
