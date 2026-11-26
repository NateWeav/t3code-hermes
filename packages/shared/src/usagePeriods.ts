// @effect-diagnostics globalDate:off -- Calendar arithmetic on YYYY-MM-DD strings in UTC; no wall-clock reads.
import type { UsageProviderKind } from "@t3tools/contracts";

import { enumerateDays, USAGE_ALL_TIME_SINCE_DAY } from "./usageFormat.ts";
import type { DailyTotals } from "./usageMerge.ts";

/** How many days one chart point covers; weeks start on Monday, months on the 1st. */
export type UsageChartGrain = "day" | "week" | "month";

const DAY_MS = 86_400_000;

/** Daily up to 90 days, weekly up to about a year, monthly beyond, so a chart keeps ~100 points at most. */
export function usageChartGrain(dayCount: number): UsageChartGrain {
  if (dayCount <= 90) return "day";
  if (dayCount <= 366) return "week";
  return "month";
}

export function usagePeriodStart(day: string, grain: UsageChartGrain): string {
  if (grain === "day") return day;
  if (grain === "month") return `${day.slice(0, 7)}-01`;
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) return day;
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

/** The period starts covering `days`, in order; `days` must be ascending. */
export function usagePeriods(days: readonly string[], grain: UsageChartGrain): readonly string[] {
  if (grain === "day") return days;
  const periods: string[] = [];
  for (const day of days) {
    const period = usagePeriodStart(day, grain);
    if (periods[periods.length - 1] !== period) periods.push(period);
  }
  return periods;
}

/** Sums daily totals into periods keyed by their start day. */
export function rollUpDaily(
  daily: readonly DailyTotals[],
  grain: UsageChartGrain,
): readonly DailyTotals[] {
  if (grain === "day") return daily;
  const periods = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  for (const entry of daily) {
    const key = usagePeriodStart(entry.day, grain);
    const period = periods.get(key) ?? { costUsd: 0, totalTokens: 0, byProvider: new Map() };
    period.costUsd += entry.costUsd;
    period.totalTokens += entry.totalTokens;
    for (const [provider, totals] of entry.byProvider) {
      const sum = period.byProvider.get(provider) ?? { costUsd: 0, totalTokens: 0 };
      sum.costUsd += totals.costUsd;
      sum.totalTokens += totals.totalTokens;
      period.byProvider.set(provider, sum);
    }
    periods.set(key, period);
  }
  return [...periods.entries()]
    .map(([day, totals]) => ({ day, ...totals }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Days a window shows. An all-time window starts at its first recorded day instead of its
 * open-ended request start, so the chart spans the history that exists.
 */
export function usageWindowDays(
  sinceDay: string,
  untilDay: string,
  daily: readonly DailyTotals[],
): readonly string[] {
  if (sinceDay !== USAGE_ALL_TIME_SINCE_DAY) return enumerateDays(sinceDay, untilDay);
  const first = daily.reduce<string | undefined>(
    (earliest, entry) => (earliest === undefined || entry.day < earliest ? entry.day : earliest),
    undefined,
  );
  return enumerateDays(first === undefined || first > untilDay ? untilDay : first, untilDay);
}
