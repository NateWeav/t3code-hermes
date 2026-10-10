// @effect-diagnostics nodeBuiltinImport:off
/** Reads canonical Hermes Agent usage totals from `state.db`. */
import * as NodeSqlite from "node:sqlite";

import type { HermesSettings } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type {
  ProviderUsageReader,
  ProviderUsageScan,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readDirectoryVolumeId } from "./usageTranscriptReader.ts";

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
        speed: "standard",
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

export type HermesUsageReaderEnv = FileSystem.FileSystem | Path.Path;

/**
 * Hermes session counters are canonical and cumulative, so each database is
 * one source rather than per-message transcript records. Every profile under
 * `<home>/profiles/<name>` keeps its own state.db and sessions.
 */
export const hermesUsageReader: ProviderUsageReader<HermesSettings, HermesUsageReaderEnv> = {
  kind: "scan",
  provider: "hermes",
  scan: Effect.fn("hermesUsageReader.scan")(function* ({ windowStartMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostEnvironment = yield* HostProcess.Environment;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const hermesHome = path.resolve(
      expandHomePath(
        hostEnvironment["HERMES_HOME"]?.trim() || path.join(homeDirectory, ".hermes"),
        homeDirectory,
      ),
    );
    const hermesProfilesDir = path.join(hermesHome, "profiles");
    const hermesProfiles = yield* fileSystem
      .readDirectory(hermesProfilesDir)
      .pipe(Effect.orElseSucceed((): string[] => []));
    const hermesHomes = [
      hermesHome,
      ...hermesProfiles
        .filter((name) => !name.startsWith("."))
        .toSorted()
        .map((name) => path.join(hermesProfilesDir, name)),
    ];
    const scanned: ProviderUsageScan[] = [];
    for (const profileHome of hermesHomes) {
      const hermesDb = path.join(profileHome, "state.db");
      const hermesExists = yield* fileSystem
        .exists(hermesDb)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      // A profile that never ran has no database and is not a source.
      if (!hermesExists && profileHome !== hermesHome) continue;
      const hermesRecords = hermesExists
        ? yield* Effect.sync(() => readHermesUsageRecords(hermesDb, windowStartMs))
        : [];
      scanned.push({
        dir: hermesDb,
        // The profile home, not the database file, identifies the source.
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(profileHome)),
        files: hermesExists ? [{ path: hermesDb, records: hermesRecords ?? [] }] : null,
        status: hermesRecords === null ? "failed" : "ok",
        ...(hermesExists
          ? hermesRecords === null
            ? { message: "Hermes state database could not be read." }
            : {}
          : { message: "No Hermes state database on this environment." }),
      });
    }
    return scanned;
  }),
};
