// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import type { ProviderQuotaWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ClaudeNativeCredentials {
  readonly accessToken: string;
  readonly planLabel: string | null;
}

export function parseClaudeNativeCredentials(value: unknown): ClaudeNativeCredentials | null {
  if (!isRecord(value) || !isRecord(value.claudeAiOauth)) return null;
  const accessToken = value.claudeAiOauth.accessToken;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;
  const subscriptionType = value.claudeAiOauth.subscriptionType;
  const rateLimitTier = value.claudeAiOauth.rateLimitTier;
  return {
    accessToken: accessToken.trim(),
    planLabel:
      typeof subscriptionType === "string" && subscriptionType.trim().length > 0
        ? subscriptionType.trim()
        : typeof rateLimitTier === "string" && rateLimitTier.trim().length > 0
          ? rateLimitTier.trim()
          : null,
  };
}

export function parseClaudeNativeCredentialsText(text: string): ClaudeNativeCredentials | null {
  try {
    return parseClaudeNativeCredentials(JSON.parse(text));
  } catch {
    return null;
  }
}

export function readClaudeNativeCredentialsFile(path: string): ClaudeNativeCredentials | null {
  try {
    return parseClaudeNativeCredentialsText(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readOpenCodeGoApiKey(path: string): string | null {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (!isRecord(value) || !isRecord(value["opencode-go"])) return null;
    const key = value["opencode-go"].key;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
}

interface OpenCodeCostRow {
  readonly createdMs: number;
  readonly cost: number;
}

function openCodeCostRows(database: NodeSqlite.DatabaseSync): readonly OpenCodeCostRow[] {
  const hasPart =
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'part' LIMIT 1")
      .get() !== undefined;
  const sql = hasPart
    ? `
        WITH provider_messages AS (
          SELECT
            id AS messageID,
            CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
            CAST(json_extract(data, '$.cost') AS REAL) AS cost,
            json_type(data, '$.cost') IN ('integer', 'real') AS hasCost
          FROM message
          WHERE json_valid(data)
            AND json_extract(data, '$.providerID') = 'opencode-go'
            AND json_extract(data, '$.role') = 'assistant'
        )
        SELECT
          CAST(COALESCE(json_extract(p.data, '$.time.created'), p.time_created, m.createdMs) AS INTEGER)
            AS createdMs,
          CAST(json_extract(p.data, '$.cost') AS REAL) AS cost
        FROM part p
        JOIN provider_messages m ON m.messageID = p.message_id
        WHERE json_valid(p.data)
          AND json_extract(p.data, '$.type') = 'step-finish'
          AND json_type(p.data, '$.cost') IN ('integer', 'real')
        UNION ALL
        SELECT createdMs, cost
        FROM provider_messages m
        WHERE hasCost
          AND NOT EXISTS (
            SELECT 1 FROM part p
            WHERE p.message_id = m.messageID
              AND json_valid(p.data)
              AND json_extract(p.data, '$.type') = 'step-finish'
              AND json_type(p.data, '$.cost') IN ('integer', 'real')
          )
      `
    : `
        SELECT
          CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
          CAST(json_extract(data, '$.cost') AS REAL) AS cost
        FROM message
        WHERE json_valid(data)
          AND json_extract(data, '$.providerID') = 'opencode-go'
          AND json_extract(data, '$.role') = 'assistant'
          AND json_type(data, '$.cost') IN ('integer', 'real')
      `;
  return (database.prepare(sql).all() as unknown as readonly OpenCodeCostRow[]).filter(
    (row) =>
      Number.isFinite(row.createdMs) &&
      row.createdMs > 0 &&
      Number.isFinite(row.cost) &&
      row.cost >= 0,
  );
}

const percent = (used: number, limit: number): number =>
  Math.round(Math.max(0, Math.min(100, (used / limit) * 100)) * 10) / 10;

const iso = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

export interface OpenCodeGoLocalQuota {
  readonly authenticated: boolean;
  readonly windows: readonly ProviderQuotaWindow[];
}

/**
 * OpenCode Go does not expose quota through its CLI credential. Match CodexBar's
 * local fallback by estimating the documented plan windows from finalized
 * `opencode-go` message costs, while using auth.json only as a sign-in signal.
 */
export function readOpenCodeGoLocalQuota(input: {
  readonly authPath: string;
  readonly databasePath: string;
  readonly nowMs: number;
}): OpenCodeGoLocalQuota {
  const authenticated = readOpenCodeGoApiKey(input.authPath) !== null;
  if (!authenticated) return { authenticated: false, windows: [] };

  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(input.databasePath, { readOnly: true, timeout: 250 });
  } catch {
    return { authenticated: true, windows: [] };
  }

  try {
    const rows = openCodeCostRows(database);
    if (rows.length === 0) return { authenticated: true, windows: [] };
    const now = DateTime.makeUnsafe(input.nowMs);
    const fiveHoursMs = 5 * 60 * 60 * 1000;
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const rollingStart = input.nowMs - fiveHoursMs;
    const weekStart = DateTime.startOf(now, "week", { weekStartsOn: 1 }).epochMilliseconds;
    const monthStartDateTime = DateTime.startOf(now, "month");
    const monthStart = monthStartDateTime.epochMilliseconds;
    const monthEnd = DateTime.add(monthStartDateTime, { months: 1 }).epochMilliseconds;
    let rollingCost = 0;
    let weeklyCost = 0;
    let monthlyCost = 0;
    let oldestRollingMs: number | null = null;
    for (const row of rows) {
      if (row.createdMs >= rollingStart && row.createdMs <= input.nowMs) {
        rollingCost += row.cost;
        oldestRollingMs =
          oldestRollingMs === null ? row.createdMs : Math.min(oldestRollingMs, row.createdMs);
      }
      if (row.createdMs >= weekStart && row.createdMs < weekStart + weekMs) weeklyCost += row.cost;
      if (row.createdMs >= monthStart && row.createdMs < monthEnd) monthlyCost += row.cost;
    }
    return {
      authenticated: true,
      windows: [
        {
          id: "five-hour",
          label: "5 hour · estimated",
          usedPercent: percent(rollingCost, 12),
          resetsAt: iso((oldestRollingMs ?? input.nowMs) + fiveHoursMs),
          durationMinutes: 5 * 60,
        },
        {
          id: "weekly",
          label: "Weekly · estimated",
          usedPercent: percent(weeklyCost, 30),
          resetsAt: iso(weekStart + weekMs),
          durationMinutes: 7 * 24 * 60,
        },
        {
          id: "monthly",
          label: "Monthly · estimated",
          usedPercent: percent(monthlyCost, 60),
          resetsAt: iso(monthEnd),
          durationMinutes: Math.round((monthEnd - monthStart) / 60_000),
        },
      ],
    };
  } catch {
    return { authenticated: true, windows: [] };
  } finally {
    database.close();
  }
}
