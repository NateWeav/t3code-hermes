import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

// What fork builds before orchestration V2 recorded: upstream through 54, then
// their own 55 adding `projection_threads.hermes_run_json`.
const seedForkLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* sql`ALTER TABLE projection_threads ADD COLUMN hermes_run_json TEXT`;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ProjectionThreadsHermesRun')
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at,
      hermes_run_json
    ) VALUES (
      'hermes-run:default:s1', 'project-1', 'Mirrored run',
      '{"instanceId":"hermes","model":"hermes-4"}', 'full-access',
      '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '{"live":false}'
    )
  `;
});

const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

describe("fork migration ledger", () => {
  it.effect("runs upstream's 55 and later on a database that recorded the fork's 55", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkLedger;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id >= 55),
      );
      assert.deepStrictEqual(yield* ledger, migrationManifest);
      assert.strictEqual(
        (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'`)
          .length,
        1,
      );
      // The fork's V1 column and its data survive for the pre-V2 thread import.
      assert.deepStrictEqual(yield* sql`SELECT hermes_run_json FROM projection_threads`, [
        { hermes_run_json: '{"live":false}' },
      ]);

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* ledger, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a database without fork rows to the migrator", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* ledger, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
