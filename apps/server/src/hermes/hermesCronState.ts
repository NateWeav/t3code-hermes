// @effect-diagnostics nodeBuiltinImport:off
/**
 * Readers for Hermes Agent's own cron state.
 *
 * Hermes keeps scheduled jobs in `<hermes home>/cron/jobs.json` and appends
 * every execution attempt to a durable SQLite ledger at
 * `<hermes home>/cron/executions.db`. Both are read here directly.
 *
 * Reading the state rather than shelling out to `hermes cron list` is a
 * deliberate choice: as of Hermes 0.20.2 the `cron` subcommand has no `--json`
 * mode (its sibling `kanban` does), so `cron list` and `cron runs` emit
 * ANSI-coloured, box-drawn prose intended for a terminal. Parsing that would
 * break on a cosmetic change. The two state files are the same thing the CLI
 * itself reads, are documented storage, and are cheap to poll.
 *
 * Everything here is defensive. These files belong to another application that
 * upgrades on its own schedule and that tolerates hand edits, so a malformed
 * record is skipped rather than allowed to fail the whole read.
 *
 * Verified against Hermes Agent 0.20.2. See `hermesCronFixtures.ts` for the
 * pinned shapes and what to do when an upgrade changes them.
 *
 * @module hermesCronState
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  HERMES_CRON_RUNS_PER_JOB,
  type HermesCronJobState,
  type HermesCronRunStatus,
} from "@t3tools/contracts";

/** Failure text is shown inline in a panel row, so it is bounded on read. */
const MAX_ERROR_TEXT_LENGTH = 400;

const RUN_STATUSES = new Set<string>(["claimed", "running", "completed", "failed", "unknown"]);

export interface HermesCronPaths {
  readonly home: string;
  readonly cronDir: string;
  readonly jobsFile: string;
  readonly executionsDb: string;
}

/**
 * Resolves the Hermes home the same way the usage reader does — `HERMES_HOME`
 * when set, otherwise `~/.hermes`.
 */
export function resolveHermesCronPaths(
  environment: NodeJS.ProcessEnv = process.env,
  homedir: string = NodeOS.homedir(),
): HermesCronPaths {
  const home = environment["HERMES_HOME"]?.trim() || NodePath.join(homedir, ".hermes");
  const cronDir = NodePath.join(home, "cron");
  return {
    home,
    cronDir,
    jobsFile: NodePath.join(cronDir, "jobs.json"),
    executionsDb: NodePath.join(cronDir, "executions.db"),
  };
}

/** A job as it appears on disk, after normalisation but before contract encoding. */
export interface ParsedHermesCronJob {
  readonly id: string;
  readonly name: string;
  readonly scheduleDisplay: string;
  readonly state: HermesCronJobState;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly deliver: readonly string[];
}

export interface ParsedHermesCronRun {
  readonly id: string;
  readonly jobId: string;
  readonly status: HermesCronRunStatus;
  readonly source: string | null;
  readonly claimedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hermes's `_coerce_job_text`: nullable and hand-edited fields are coerced to
 * text for readers rather than rejected.
 */
function coerceText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function nonEmptyOrNull(value: unknown): string | null {
  const text = coerceText(value).trim();
  return text.length === 0 ? null : text;
}

function boundedError(value: unknown): string | null {
  const text = nonEmptyOrNull(value);
  if (text === null) return null;
  return text.length > MAX_ERROR_TEXT_LENGTH ? `${text.slice(0, MAX_ERROR_TEXT_LENGTH)}…` : text;
}

/**
 * Port of Hermes's `_schedule_display_for_job`. The stored `schedule_display`
 * wins; otherwise the first populated key of the parsed schedule object.
 */
function scheduleDisplayFor(job: Record<string, unknown>): string {
  const display = coerceText(job["schedule_display"]).trim();
  if (display.length > 0) return display;

  const schedule = job["schedule"];
  if (isRecord(schedule)) {
    for (const key of ["display", "value", "expr", "run_at"] as const) {
      const text = coerceText(schedule[key]).trim();
      if (text.length > 0) return text;
    }
    return "?";
  }
  if (schedule !== null && schedule !== undefined) {
    const text = coerceText(schedule).trim();
    if (text.length > 0) return text;
  }
  return "?";
}

function hasPauseMarker(job: Record<string, unknown>): boolean {
  if (coerceText(job["state"]).trim() === "paused") return true;
  return Boolean(job["paused_at"]);
}

/**
 * Port of Hermes's `effective_job_state`.
 *
 * The subtlety worth preserving: `enabled: true` is authoritative, so a record
 * that still carries a stale `paused` label reads as scheduled. Hermes learned
 * that the hard way — a list that showed every job as paused while the
 * scheduler happily kept firing them.
 */
export function effectiveJobState(job: Record<string, unknown>): HermesCronJobState {
  const stored = coerceText(job["state"]).trim();
  if (stored === "completed" || stored === "error") return stored;

  const enabled = job["enabled"] === undefined ? true : Boolean(job["enabled"]);
  if (!enabled) {
    if (hasPauseMarker(job) || stored === "paused") return "paused";
    return isJobState(stored) ? stored : "paused";
  }
  if (stored === "paused" || job["paused_at"]) return "scheduled";
  return isJobState(stored) ? stored : "scheduled";
}

function isJobState(value: string): value is HermesCronJobState {
  return value === "scheduled" || value === "paused" || value === "completed" || value === "error";
}

/**
 * Port of Hermes's own `deliver` coalescing. The field can be absent, null, a
 * bare string, or a list; a null slipping through once crashed the CLI's whole
 * listing, which is why this is spelled out rather than defaulted.
 */
function parseDeliver(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length === 0 ? ["local"] : [text];
  }
  if (Array.isArray(value)) {
    const targets = value
      .map((entry) => coerceText(entry).trim())
      .filter((entry) => entry.length > 0);
    return targets.length === 0 ? ["local"] : targets;
  }
  return ["local"];
}

/**
 * Parses the contents of `jobs.json`.
 *
 * Accepts both shapes Hermes itself accepts: the canonical `{"jobs": [...]}`
 * wrapper and a bare array, which Hermes auto-repairs on its next write.
 * Returns `null` only when the payload is neither.
 */
export function parseHermesCronJobs(raw: unknown): readonly ParsedHermesCronJob[] | null {
  const entries = isRecord(raw) ? raw["jobs"] : raw;
  if (!Array.isArray(entries)) return null;

  const jobs: ParsedHermesCronJob[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = coerceText(entry["id"]).trim();
    // A record without an id cannot be paused, muted, or correlated with a
    // run. Hermes tolerates them on disk; there is nothing for a panel to do
    // with one.
    if (id.length === 0) continue;

    const name = coerceText(entry["name"]).trim();
    jobs.push({
      id,
      name: name.length === 0 ? "(unnamed)" : name,
      scheduleDisplay: scheduleDisplayFor(entry),
      state: effectiveJobState(entry),
      enabled: entry["enabled"] === undefined ? true : Boolean(entry["enabled"]),
      nextRunAt: nonEmptyOrNull(entry["next_run_at"]),
      lastRunAt: nonEmptyOrNull(entry["last_run_at"]),
      lastStatus: nonEmptyOrNull(entry["last_status"]),
      lastError: boundedError(entry["last_error"]),
      deliver: parseDeliver(entry["deliver"]),
    });
  }
  return jobs;
}

function parseTimestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(startedAt: string | null, finishedAt: string | null): number | null {
  const start = parseTimestampMs(startedAt);
  const end = parseTimestampMs(finishedAt);
  if (start === null || end === null) return null;
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : null;
}

/** Shape of one row of the Hermes `executions` table. */
interface ExecutionRow {
  readonly id: unknown;
  readonly job_id: unknown;
  readonly status: unknown;
  readonly source: unknown;
  readonly claimed_at: unknown;
  readonly started_at: unknown;
  readonly finished_at: unknown;
  readonly error: unknown;
}

export function parseHermesCronRun(row: ExecutionRow): ParsedHermesCronRun | null {
  const id = coerceText(row.id).trim();
  const jobId = coerceText(row.job_id).trim();
  if (id.length === 0 || jobId.length === 0) return null;

  const status = coerceText(row.status).trim();
  // The column is CHECK-constrained in Hermes, so an unrecognised value means
  // the ledger schema moved. Drop the row rather than invent a status.
  if (!RUN_STATUSES.has(status)) return null;

  const startedAt = nonEmptyOrNull(row.started_at);
  const finishedAt = nonEmptyOrNull(row.finished_at);
  return {
    id,
    jobId,
    status: status as HermesCronRunStatus,
    source: nonEmptyOrNull(row.source),
    claimedAt: nonEmptyOrNull(row.claimed_at),
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    error: boundedError(row.error),
  };
}

export function parseHermesCronRuns(rows: readonly ExecutionRow[]): readonly ParsedHermesCronRun[] {
  const runs: ParsedHermesCronRun[] = [];
  for (const row of rows) {
    const run = parseHermesCronRun(row);
    if (run !== null) runs.push(run);
  }
  return runs;
}

/**
 * Groups runs by job, newest first, capped per job.
 *
 * The ledger query already orders newest-first across all jobs, so the cap can
 * be applied while grouping.
 */
export function groupRunsByJob(
  runs: readonly ParsedHermesCronRun[],
  perJob: number = HERMES_CRON_RUNS_PER_JOB,
): ReadonlyMap<string, readonly ParsedHermesCronRun[]> {
  const grouped = new Map<string, ParsedHermesCronRun[]>();
  for (const run of runs) {
    const existing = grouped.get(run.jobId);
    if (existing === undefined) {
      grouped.set(run.jobId, [run]);
    } else if (existing.length < perJob) {
      existing.push(run);
    }
  }
  return grouped;
}

/**
 * Reads the newest execution attempts for each requested job.
 *
 * The cap is applied **per job**, not globally: a job that fires every five
 * minutes must not crowd a quiet weekly job out of the snapshot, and must not
 * keep its own old runs from the notification ledger. One `SELECT` per job is
 * deliberate — SQLite has no practical per-`IN`-group LIMIT, and each of these
 * stays on the `(job_id, claimed_at DESC, id DESC)` index Hermes builds.
 *
 * Returns `null` when the ledger cannot be opened at all — a fresh Hermes
 * install has jobs before it has ever run one, and the panel is still useful
 * without history, so this is a soft failure rather than an error.
 */
export function readHermesCronRuns(
  dbPath: string,
  jobIds: readonly string[],
  perJob: number = HERMES_CRON_RUNS_PER_JOB,
): readonly ParsedHermesCronRun[] | null {
  if (jobIds.length === 0) return [];

  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
  } catch {
    return null;
  }

  try {
    // Hermes indexes `(job_id, claimed_at DESC, id DESC)`, so this mirrors its
    // own `list_executions` ordering and stays on the index.
    const statement = database.prepare(`
      SELECT id, job_id, status, source, claimed_at, started_at, finished_at, error
      FROM executions
      WHERE job_id = ?
      ORDER BY claimed_at DESC, id DESC
      LIMIT ?
    `);
    const rows: ExecutionRow[] = [];
    for (const jobId of jobIds) {
      rows.push(...(statement.all(jobId, perJob) as unknown as readonly ExecutionRow[]));
    }
    return parseHermesCronRuns(rows);
  } catch {
    return null;
  } finally {
    database.close();
  }
}
