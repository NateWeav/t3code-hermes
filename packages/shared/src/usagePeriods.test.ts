import { describe, expect, it } from "vite-plus/test";

import { USAGE_ALL_TIME_SINCE_DAY } from "./usageFormat.ts";
import type { DailyTotals } from "./usageMerge.ts";
import {
  rollUpDaily,
  usageChartGrain,
  usagePeriods,
  usagePeriodStart,
  usageWindowDays,
} from "./usagePeriods.ts";

function day(date: string, codexUsd: number, claudeUsd = 0): DailyTotals {
  const byProvider = new Map<"codex" | "claude", { costUsd: number; totalTokens: number }>();
  if (codexUsd > 0) byProvider.set("codex", { costUsd: codexUsd, totalTokens: codexUsd * 10 });
  if (claudeUsd > 0) byProvider.set("claude", { costUsd: claudeUsd, totalTokens: claudeUsd * 10 });
  return {
    day: date,
    costUsd: codexUsd + claudeUsd,
    totalTokens: (codexUsd + claudeUsd) * 10,
    byProvider,
  };
}

describe("usageChartGrain", () => {
  it("keeps days through 90, weeks through a year, then months", () => {
    expect(usageChartGrain(1)).toBe("day");
    expect(usageChartGrain(90)).toBe("day");
    expect(usageChartGrain(91)).toBe("week");
    expect(usageChartGrain(366)).toBe("week");
    expect(usageChartGrain(367)).toBe("month");
  });
});

describe("usagePeriodStart", () => {
  it("starts weeks on Monday and months on the 1st", () => {
    // 2026-11-26 is a Thursday.
    expect(usagePeriodStart("2026-11-26", "week")).toBe("2026-11-23");
    expect(usagePeriodStart("2026-11-23", "week")).toBe("2026-11-23");
    expect(usagePeriodStart("2026-11-22", "week")).toBe("2026-11-16");
    expect(usagePeriodStart("2026-03-01", "week")).toBe("2026-02-23");
    expect(usagePeriodStart("2026-11-26", "month")).toBe("2026-11-01");
    expect(usagePeriodStart("2026-11-26", "day")).toBe("2026-11-26");
  });
});

describe("usagePeriods", () => {
  it("lists each period once, in order", () => {
    const days = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"];
    expect(usagePeriods(days, "month")).toEqual(["2026-10-01", "2026-11-01"]);
    expect(usagePeriods(days, "week")).toEqual(["2026-10-26", "2026-11-02"]);
    expect(usagePeriods(days, "day")).toBe(days);
  });
});

describe("rollUpDaily", () => {
  it("sums totals and per-provider figures into each period", () => {
    const rolled = rollUpDaily(
      [day("2026-11-02", 1, 2), day("2026-10-31", 4), day("2026-11-03", 3)],
      "month",
    );
    expect(rolled.map((entry) => [entry.day, entry.costUsd])).toEqual([
      ["2026-10-01", 4],
      ["2026-11-01", 6],
    ]);
    expect(rolled[1]?.byProvider.get("codex")).toEqual({ costUsd: 4, totalTokens: 40 });
    expect(rolled[1]?.byProvider.get("claude")).toEqual({ costUsd: 2, totalTokens: 20 });
    expect(rolled[1]?.totalTokens).toBe(60);
  });

  it("does not alter the input's provider maps", () => {
    const input = [day("2026-11-02", 1), day("2026-11-03", 2)];
    rollUpDaily(input, "week");
    expect(input[0]?.byProvider.get("codex")).toEqual({ costUsd: 1, totalTokens: 10 });
  });
});

describe("usageWindowDays", () => {
  it("enumerates a bounded window as is", () => {
    expect(usageWindowDays("2026-11-24", "2026-11-26", [])).toEqual([
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
    ]);
  });

  it("starts an all-time window at its first recorded day", () => {
    expect(
      usageWindowDays(USAGE_ALL_TIME_SINCE_DAY, "2026-11-26", [
        day("2026-11-25", 1),
        day("2026-11-24", 1),
      ]),
    ).toEqual(["2026-11-24", "2026-11-25", "2026-11-26"]);
  });

  it("shows only today for an all-time window with no history", () => {
    expect(usageWindowDays(USAGE_ALL_TIME_SINCE_DAY, "2026-11-26", [])).toEqual(["2026-11-26"]);
  });
});
