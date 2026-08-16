// @effect-diagnostics nodeBuiltinImport:off
/** Reads canonical Hermes Agent usage totals from `state.db`. */
import * as NodeSqlite from "node:sqlite";

import type { UsageRecord } from "./usageTranscripts.ts";

interface HermesSessionRow {
  readonly id: unknown;
  readonly model: unknown;
  readonly started_at: unknown;
  readonly ended_at: unknown;
  readonly last_message_at: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_read_tokens: unknown;
  readonly cache_write_tokens: unknown;
  readonly reasoning_tokens: unknown;
  readonly estimated_cost_usd: unknown;
  readonly actual_cost_usd: unknown;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveFiniteNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function unixSeconds(value: unknown): number | null {
  const seconds = finiteNumber(value);
  return seconds === null || seconds < 0 ? null : seconds;
}

/**
 * Returns one record per Hermes session. Session counters are canonical and
 * cumulative, so they must not be combined with per-message token estimates.
 */
export function readHermesUsageRecords(
  dbPath: string,
  sinceMs: number,
): readonly UsageRecord[] | null {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
  } catch {
    return null;
  }

  try {
    const rows = database
      .prepare(`
        SELECT
          s.id,
          s.model,
          s.started_at,
          s.ended_at,
          MAX(m.timestamp) AS last_message_at,
          s.input_tokens,
          s.output_tokens,
          s.cache_read_tokens,
          s.cache_write_tokens,
          s.reasoning_tokens,
          s.estimated_cost_usd,
          s.actual_cost_usd
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        HAVING MAX(
          s.started_at,
          COALESCE(s.ended_at, 0),
          COALESCE(MAX(m.timestamp), 0)
        ) >= ?
        ORDER BY s.started_at
      `)
      .all(sinceMs / 1000) as unknown as readonly HermesSessionRow[];

    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      if (typeof row.model !== "string" || row.model.trim().length === 0) continue;

      const totals = {
        uncachedInputTokens: nonNegativeInt(row.input_tokens),
        cachedInputTokens: nonNegativeInt(row.cache_read_tokens),
        cacheCreationTokens: nonNegativeInt(row.cache_write_tokens),
        outputTokens: nonNegativeInt(row.output_tokens),
        reasoningTokens: nonNegativeInt(row.reasoning_tokens),
      };
      if (
        totals.uncachedInputTokens +
          totals.cachedInputTokens +
          totals.cacheCreationTokens +
          totals.outputTokens ===
        0
      ) {
        continue;
      }

      const timestampSeconds =
        unixSeconds(row.last_message_at) ??
        unixSeconds(row.ended_at) ??
        unixSeconds(row.started_at);
      if (timestampSeconds === null) continue;

      records.push({
        provider: "hermes",
        timestampMs: timestampSeconds * 1000,
        model: row.model.trim(),
        sessionId: row.id,
        totals,
        // Hermes initializes unknown costs to numeric zero. Zero is not a
        // provider-reported price: let T3's model-rate table estimate it.
        reportedCostUsd:
          positiveFiniteNumber(row.actual_cost_usd) ?? positiveFiniteNumber(row.estimated_cost_usd),
        dedupeKey: null,
      });
    }
    return records;
  } catch {
    return null;
  } finally {
    database.close();
  }
}
