import type { ProviderQuotaWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const boundedPercent = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
};

const isoFromEpochSeconds = (value: unknown): string | null => {
  const seconds = finiteNumber(value);
  if (seconds === null) return null;
  return Option.getOrNull(DateTime.make(seconds * 1000).pipe(Option.map(DateTime.formatIso)));
};

function windowLabel(durationMinutes: number | null, fallback: string): string {
  if (durationMinutes === null) return fallback;
  if (durationMinutes < 60) return `${durationMinutes} minute`;
  if (durationMinutes < 24 * 60 && durationMinutes % 60 === 0)
    return `${durationMinutes / 60} hour`;
  if (durationMinutes % (7 * 24 * 60) === 0) {
    const weeks = durationMinutes / (7 * 24 * 60);
    return weeks === 1 ? "Weekly" : `${weeks} week`;
  }
  if (durationMinutes % (24 * 60) === 0) return `${durationMinutes / (24 * 60)} day`;
  return fallback;
}

function parseCodexWindow(
  value: unknown,
  id: string,
  fallbackLabel: string,
): ProviderQuotaWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = boundedPercent(value.usedPercent);
  if (usedPercent === null) return null;
  const durationMinutes = finiteNumber(value.windowDurationMins);
  return {
    id,
    label: windowLabel(durationMinutes, fallbackLabel),
    usedPercent,
    resetsAt: isoFromEpochSeconds(value.resetsAt),
    durationMinutes: durationMinutes !== null && durationMinutes > 0 ? durationMinutes : null,
  };
}

export function parseCodexRateLimits(value: unknown): {
  readonly planLabel: string | null;
  readonly windows: readonly ProviderQuotaWindow[];
} {
  if (!isRecord(value)) return { planLabel: null, windows: [] };
  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : value;
  const windows = [
    parseCodexWindow(rateLimits.primary, "primary", "Primary"),
    parseCodexWindow(rateLimits.secondary, "secondary", "Secondary"),
  ].filter((window): window is ProviderQuotaWindow => window !== null);
  return {
    planLabel: typeof rateLimits.planType === "string" ? rateLimits.planType : null,
    windows,
  };
}

interface ClaudeUsageWindow {
  readonly utilization?: unknown;
  readonly resets_at?: unknown;
}

function parseClaudeWindow(
  value: unknown,
  id: string,
  label: string,
  durationMinutes: number,
): ProviderQuotaWindow | null {
  if (!isRecord(value)) return null;
  const window = value as ClaudeUsageWindow;
  const usedPercent = boundedPercent(window.utilization);
  if (usedPercent === null) return null;
  const resetsAt =
    typeof window.resets_at === "string" ? Option.getOrNull(DateTime.make(window.resets_at)) : null;
  return {
    id,
    label,
    usedPercent,
    resetsAt: resetsAt === null ? null : DateTime.formatIso(resetsAt),
    durationMinutes,
  };
}

export function parseClaudeUsage(value: unknown): readonly ProviderQuotaWindow[] {
  if (!isRecord(value)) return [];
  return [
    parseClaudeWindow(value.five_hour, "five-hour", "5 hour", 5 * 60),
    parseClaudeWindow(value.seven_day, "seven-day", "Weekly", 7 * 24 * 60),
    parseClaudeWindow(value.seven_day_opus, "seven-day-opus", "Weekly · Opus", 7 * 24 * 60),
    parseClaudeWindow(value.seven_day_sonnet, "seven-day-sonnet", "Weekly · Sonnet", 7 * 24 * 60),
  ].filter((window): window is ProviderQuotaWindow => window !== null);
}

const PERCENT_KEYS = [
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "usage_percent",
  "used_percent",
  "utilizationPercent",
  "utilization_percent",
];
const RESET_SECONDS_KEYS = [
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_in_sec",
  "resetsInSec",
];
const RESET_AT_KEYS = ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "renewAt"];

function valueForKeys(record: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function parseOpenCodeWindow(
  record: JsonRecord,
  id: string,
  label: string,
  nowMs: number,
): ProviderQuotaWindow | null {
  const apiPercent = boundedPercent(record.percent);
  let usedPercent = apiPercent ?? boundedPercent(valueForKeys(record, PERCENT_KEYS));
  if (apiPercent === null && usedPercent !== null && usedPercent <= 1) usedPercent *= 100;
  if (usedPercent === null) {
    const used = finiteNumber(valueForKeys(record, ["used", "consumed", "count", "usedTokens"]));
    const limit = finiteNumber(valueForKeys(record, ["limit", "total", "quota", "max", "cap"]));
    if (used !== null && limit !== null && limit > 0) {
      usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
    }
  }
  if (usedPercent === null) return null;
  const resetSeconds = finiteNumber(valueForKeys(record, RESET_SECONDS_KEYS));
  const rawResetAt = valueForKeys(record, RESET_AT_KEYS);
  let resetsAt: string | null = null;
  if (resetSeconds !== null) {
    resetsAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + resetSeconds * 1000));
  } else if (typeof rawResetAt === "string" || typeof rawResetAt === "number") {
    resetsAt = Option.getOrNull(DateTime.make(rawResetAt).pipe(Option.map(DateTime.formatIso)));
  }
  return { id, label, usedPercent, resetsAt, durationMinutes: null };
}

function findNamedRecord(value: unknown, pattern: RegExp, depth = 0): JsonRecord | null {
  if (depth > 4 || !isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    if (pattern.test(key) && isRecord(nested)) return nested;
  }
  for (const nested of Object.values(value)) {
    const found = findNamedRecord(nested, pattern, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export function parseOpenCodeGoUsage(
  value: unknown,
  nowMs: number,
): readonly ProviderQuotaWindow[] {
  const definitions = [
    { id: "five-hour", label: "5 hour", pattern: /(rolling|five.?hour|5h)/i },
    { id: "weekly", label: "Weekly", pattern: /week/i },
    { id: "monthly", label: "Monthly", pattern: /month/i },
  ];
  return definitions
    .map(({ id, label, pattern }) => {
      const record = findNamedRecord(value, pattern);
      return record === null ? null : parseOpenCodeWindow(record, id, label, nowMs);
    })
    .filter((window): window is ProviderQuotaWindow => window !== null);
}

export function parseOpenCodeGoDocument(text: string, nowMs: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const candidates = [...text.matchAll(/\{[^<>]{20,4000}\}/g)];
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate[0]);
        if (parseOpenCodeGoUsage(parsed, nowMs).length > 0) return parsed;
      } catch {
        // Continue through embedded JSON candidates.
      }
    }
    return null;
  }
}
