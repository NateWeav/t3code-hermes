import { describe, expect, it } from "@effect/vitest";

import {
  parseClaudeUsage,
  parseCodexRateLimits,
  parseOpenCodeGoDocument,
  parseOpenCodeGoUsage,
} from "./providerQuotaReaders.ts";

describe("provider quota readers", () => {
  it("normalizes Codex primary and secondary windows", () => {
    const parsed = parseCodexRateLimits({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 72, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 38, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
    });

    expect(parsed.planLabel).toBe("plus");
    expect(parsed.windows).toEqual([
      {
        id: "primary",
        label: "5 hours",
        usedPercent: 72,
        resetsAt: "2027-01-15T08:00:00.000Z",
        durationMinutes: 300,
      },
      {
        id: "secondary",
        label: "Weekly",
        usedPercent: 38,
        resetsAt: "2027-01-21T02:53:20.000Z",
        durationMinutes: 10_080,
      },
    ]);
  });

  it("normalizes Claude OAuth windows", () => {
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 41, resets_at: "2026-08-16T21:00:00Z" },
        seven_day: { utilization: 23, resets_at: "2026-08-17T07:00:00Z" },
      }),
    ).toMatchObject([
      { id: "five-hour", label: "5 hour", usedPercent: 41 },
      { id: "seven-day", label: "Weekly", usedPercent: 23 },
    ]);
  });

  it("finds OpenCode Go rolling, weekly, and monthly windows in nested data", () => {
    const now = 1_700_000_000_000;
    expect(
      parseOpenCodeGoUsage(
        {
          payload: {
            rollingUsage: { usagePercent: 0.64, resetInSec: 600 },
            weeklyWindow: { used: 25, limit: 100, resetInSeconds: 1200 },
            monthly_usage: { usedPercent: 86, resetSeconds: 1800 },
          },
        },
        now,
      ),
    ).toMatchObject([
      { id: "five-hour", usedPercent: 64, resetsAt: "2023-11-14T22:23:20.000Z" },
      { id: "weekly", usedPercent: 25, resetsAt: "2023-11-14T22:33:20.000Z" },
      { id: "monthly", usedPercent: 86, resetsAt: "2023-11-14T22:43:20.000Z" },
    ]);
  });

  it("parses the OpenCode Go API usage response without treating one percent as 100", () => {
    expect(
      parseOpenCodeGoUsage(
        {
          usage: {
            rolling: { status: "ok", percent: 1, resetsAt: "2026-08-16T11:24:29.191Z" },
            weekly: { status: "ok", percent: 21, resetsAt: "2026-08-17T00:00:00.191Z" },
            monthly: { status: "ok", percent: 42, resetsAt: "2026-09-07T06:59:22.191Z" },
          },
        },
        0,
      ),
    ).toMatchObject([
      { id: "five-hour", usedPercent: 1 },
      { id: "weekly", usedPercent: 21 },
      { id: "monthly", usedPercent: 42 },
    ]);
  });

  it("keeps a fallback usagePercent value of one as one percent", () => {
    expect(parseOpenCodeGoUsage({ usage: { rolling: { usagePercent: 1 } } }, 0)).toMatchObject([
      { id: "five-hour", usedPercent: 1 },
    ]);
  });

  it("finds named quota windows nested inside arrays", () => {
    expect(
      parseOpenCodeGoUsage({ payloads: [{ weeklyWindow: { used: 1, limit: 4 } }] }, 0),
    ).toMatchObject([{ id: "weekly", usedPercent: 25 }]);
  });

  it("parses plain and embedded OpenCode Go quota documents", () => {
    const document = { usage: { rolling: { percent: 12 } } };
    expect(parseOpenCodeGoDocument(JSON.stringify(document), 0)).toEqual(document);
    expect(
      parseOpenCodeGoDocument(
        `<html><script>${JSON.stringify({ weeklyWindow: { percent: 34 } })}</script></html>`,
        0,
      ),
    ).toEqual({ weeklyWindow: { percent: 34 } });
    expect(parseOpenCodeGoDocument("<html>No quota data</html>", 0)).toBeNull();
  });

  it("rejects non-positive Codex window durations", () => {
    expect(
      parseCodexRateLimits({
        primary: { usedPercent: 10, windowDurationMins: 0, resetsAt: 1_800_000_000 },
      }).windows,
    ).toMatchObject([{ id: "primary", label: "Primary", durationMinutes: null }]);
  });

  it("does not turn malformed provider payloads into zero usage", () => {
    expect(parseCodexRateLimits({}).windows).toEqual([]);
    expect(parseClaudeUsage({ five_hour: null })).toEqual([]);
    expect(parseOpenCodeGoUsage({ usage: "unknown" }, 0)).toEqual([]);
  });
});
