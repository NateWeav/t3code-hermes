// Fork: threads mirrored from Hermes runs before V2 keep their run.
import { assert, it } from "@effect/vitest";
import { ThreadId, type ThreadHermesRun } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const storesProvided = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  EventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);
const eventSinkProvided = EventSink.layer.pipe(Layer.provide(storesProvided));
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
  ),
);

const encodeHermesRun = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const liveRun = (sessionId: string): ThreadHermesRun => ({
  profile: "upstream-sync",
  sourceKey: "webhook:upstream-sync",
  sourceLabel: "webhook/upstream-sync",
  sessionId,
  latestSessionId: sessionId,
  live: true,
});

const insertThread = (threadId: ThreadId, hermesRun: ThreadHermesRun | null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, hermes_run_json
      ) VALUES (
        ${threadId}, 'project:hermes', 'Mirrored run',
        '{"instanceId":"hermes","model":"hermes-4"}', 'full-access', 'default',
        '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z',
        ${hermesRun === null ? null : encodeHermesRun(hermesRun)}
      )
    `,
  );

it.layer(TestLayer)("LegacyV1ThreadImporter Hermes runs", (it) => {
  it.effect("imports a fork thread's Hermes run, finished, and repairs earlier imports", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      // What the fork's V1 migration 55 added.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN hermes_run_json TEXT`;
      const mirrored = ThreadId.make("hermes-run:upstream-sync:s1");
      const plain = ThreadId.make("thread:plain");
      yield* insertThread(mirrored, liveRun("s1"));
      yield* insertThread(plain, null);

      yield* importer.reconcileShells;
      assert.deepStrictEqual((yield* projections.getThread(mirrored)).hermesRun, {
        ...liveRun("s1"),
        live: false,
      });
      assert.isUndefined((yield* projections.getThread(plain)).hermesRun);

      // A thread imported before the importer carried runs gets it on repair, once.
      const earlier = ThreadId.make("hermes-run:upstream-sync:s2");
      yield* insertThread(earlier, null);
      yield* importer.reconcileShells;
      yield* sql`UPDATE projection_threads SET hermes_run_json = ${encodeHermesRun(liveRun("s2"))} WHERE thread_id = ${earlier}`;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      assert.strictEqual((yield* projections.getThread(earlier)).hermesRun?.sessionId, "s2");
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
    }),
  );
});
