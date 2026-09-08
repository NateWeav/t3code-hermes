import type { ServerProviderUsageWindow } from "@t3tools/contracts";
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

const OPEN_CODE_DOCUMENT_SCAN_CHAR_LIMIT = 256 * 1024;
const OPEN_CODE_DOCUMENT_CANDIDATE_LIMIT = 64;

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
): ServerProviderUsageWindow | null {
  const apiPercent = boundedPercent(record.percent);
  let usedPercent = apiPercent ?? boundedPercent(valueForKeys(record, PERCENT_KEYS));
  if (apiPercent === null && usedPercent !== null && usedPercent < 1) usedPercent *= 100;
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
  return {
    id,
    kind: id === "five-hour" ? "session" : id === "weekly" ? "weekly" : "monthly",
    label,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function findNamedRecord(value: unknown, pattern: RegExp, depth = 0): JsonRecord | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findNamedRecord(nested, pattern, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
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
): readonly ServerProviderUsageWindow[] {
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
    .filter((window): window is ServerProviderUsageWindow => window !== null);
}

export function parseOpenCodeGoDocument(text: string, nowMs: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const documentPrefix = text.slice(0, OPEN_CODE_DOCUMENT_SCAN_CHAR_LIMIT);
    let candidateCount = 0;
    for (const candidate of documentPrefix.matchAll(/\{[^<>]{20,4000}\}/g)) {
      candidateCount += 1;
      if (candidateCount > OPEN_CODE_DOCUMENT_CANDIDATE_LIMIT) break;
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
