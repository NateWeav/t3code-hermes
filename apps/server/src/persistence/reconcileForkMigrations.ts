import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork: migrations this fork once recorded in the shared ledger under an id
 * upstream has since assigned to its own migration.
 *
 * The migrator skips by id, so a database that recorded fork migration 55
 * (`ProjectionThreadsHermesRun`, which added `projection_threads.hermes_run_json`)
 * would never run upstream's 55 (`OrchestrationV2`) and would open without the
 * V2 schema. Forgetting the fork row lets upstream's 55 and later run. The
 * column it added stays: it is nullable, nothing upstream reads it, and
 * HermesRunService reads it once to bring pre-V2 run threads forward (V2 keeps
 * `hermesRun` in the thread's event payload, outside the migrator).
 *
 * The fork keeps no rows in this ledger from here on, so this list only ever
 * shrinks to what old fork builds shipped.
 */
const FORK_LEDGER_ROWS = [{ id: 55, name: "ProjectionThreadsHermesRun" }] as const;

export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  for (const row of FORK_LEDGER_ROWS) {
    yield* sql`
      DELETE FROM effect_sql_migrations WHERE migration_id = ${row.id} AND name = ${row.name}
    `;
  }
});
