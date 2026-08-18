/**
 * Version-pinned fixtures for Hermes Agent's cron state.
 *
 * Everything here is transcribed from Hermes Agent **0.20.2**
 * (`NousResearch/hermes-agent`, commit `3c108589`):
 *
 * - {@link HERMES_EXECUTIONS_DDL} is the `CREATE TABLE` from
 *   `cron/executions.py::_initialize_schema`, verbatim including the `CHECK`
 *   constraint on `status`.
 * - {@link makeHermesJobRecord} produces the full key set that
 *   `cron/jobs.py::create_job` writes into `jobs.json`.
 *
 * These exist so a Hermes upgrade fails loudly here instead of quietly in a
 * user's panel. If a test in `hermesCronState.test.ts` starts failing after a
 * Hermes bump, that is the fixture doing its job: re-read the two source files
 * above, update these shapes, and decide whether the reader needs to change.
 *
 * @module hermesCronFixtures
 */

/** The Hermes release these fixtures were transcribed from. */
export const HERMES_FIXTURE_VERSION = "0.20.2";

/**
 * Verbatim from `cron/executions.py`. The `CHECK` constraint is load-bearing:
 * it is what guarantees the reader only ever sees the five statuses it knows,
 * and inserting an unknown status into a fixture built from this DDL fails at
 * the database rather than silently passing.
 */
export const HERMES_EXECUTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    source TEXT NOT NULL,
    process_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    process_started_at INTEGER,
    status TEXT NOT NULL CHECK(status IN
      ('claimed','running','completed','failed','unknown')),
    claimed_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_executions_job_claimed
    ON executions(job_id, claimed_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_executions_status_claimed
    ON executions(status, claimed_at DESC, id DESC);
`;

/**
 * Every key `create_job` writes, with its documented default. Overrides are
 * shallow-merged, so a test states only the field it is about.
 */
export function makeHermesJobRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "job-1",
    name: "Morning digest",
    prompt: "Summarise overnight CI failures",
    skills: [],
    skill: null,
    model: null,
    provider: null,
    provider_snapshot: null,
    model_snapshot: null,
    base_url: null,
    script: null,
    no_agent: false,
    monitor_script: null,
    monitor_url: null,
    monitor_state: null,
    context_from: null,
    schedule: { type: "cron", value: "0 9 * * *", display: "every day at 09:00" },
    schedule_display: "every day at 09:00",
    repeat: { times: null, completed: 0 },
    enabled: true,
    state: "scheduled",
    paused_at: null,
    paused_reason: null,
    created_at: "2026-08-01T09:00:00Z",
    next_run_at: "2026-08-17T09:00:00Z",
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_delivery_error: null,
    deliver: ["local"],
    origin: null,
    enabled_toolsets: null,
    workdir: null,
    ...overrides,
  };
}

/** The canonical on-disk wrapper: `{"jobs": [...]}`. */
export function makeHermesJobsFile(jobs: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ jobs });
}

/** A row of the `executions` table, with `create_job`-era defaults. */
export function makeHermesExecutionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "exec-1",
    job_id: "job-1",
    source: "ticker",
    process_id: "abc123",
    pid: 4242,
    process_started_at: 1_755_000_000,
    status: "completed",
    claimed_at: "2026-08-16T09:00:00Z",
    started_at: "2026-08-16T09:00:01Z",
    finished_at: "2026-08-16T09:00:31Z",
    error: null,
    ...overrides,
  };
}
