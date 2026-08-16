// @effect-diagnostics nodeBuiltinImport:off
/** Reads finalized assistant usage from OpenCode's local SQLite database. */
import * as NodeSqlite from "node:sqlite";

import type { UsageRecord } from "./usageTranscripts.ts";

interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * OpenCode persists provider-aware cost on every completed assistant message.
 * That figure is authoritative for subscription providers such as OpenCode Go,
 * whose Kimi rates do not necessarily match a public model-family rate.
 */
export function readOpenCodeUsageRecords(
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
        SELECT id, session_id, time_created, data
        FROM message
        WHERE time_created >= ?
          AND json_extract(data, '$.role') = 'assistant'
          AND json_extract(data, '$.time.completed') IS NOT NULL
        ORDER BY time_created, id
      `)
      .all(sinceMs) as unknown as readonly OpenCodeMessageRow[];

    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || row.id.length === 0) continue;
      if (typeof row.session_id !== "string" || row.session_id.length === 0) continue;
      if (typeof row.time_created !== "number" || !Number.isFinite(row.time_created)) continue;
      if (typeof row.data !== "string") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const message = parsed as Record<string, unknown>;
      const providerId = message["providerID"];
      const modelId = message["modelID"];
      if (typeof providerId !== "string" || providerId.trim().length === 0) continue;
      if (typeof modelId !== "string" || modelId.trim().length === 0) continue;

      const tokens = message["tokens"];
      if (typeof tokens !== "object" || tokens === null) continue;
      const tokenRecord = tokens as Record<string, unknown>;
      const cache = tokenRecord["cache"];
      const cacheRecord =
        typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : {};
      const totals = {
        uncachedInputTokens: nonNegativeInt(tokenRecord["input"]),
        cachedInputTokens: nonNegativeInt(cacheRecord["read"]),
        cacheCreationTokens: nonNegativeInt(cacheRecord["write"]),
        outputTokens: nonNegativeInt(tokenRecord["output"]),
        reasoningTokens: nonNegativeInt(tokenRecord["reasoning"]),
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

      const time = message["time"];
      const completedAt =
        typeof time === "object" && time !== null
          ? finiteNumber((time as Record<string, unknown>)["completed"])
          : null;
      records.push({
        provider: "opencode",
        timestampMs: completedAt ?? row.time_created,
        model: `${providerId.trim()}/${modelId.trim()}`,
        sessionId: row.session_id,
        totals,
        reportedCostUsd: finiteNumber(message["cost"]),
        dedupeKey: `opencode:${row.id}`,
      });
    }
    return records;
  } catch {
    return null;
  } finally {
    database.close();
  }
}
