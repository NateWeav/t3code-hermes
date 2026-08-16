// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { readHermesUsageRecords } from "./usageHermes.ts";

function withDatabase(run: (path: string, database: NodeSqlite.DatabaseSync) => void): void {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-usage-"));
  const dbPath = NodePath.join(dir, "state.db");
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL,
        actual_cost_usd REAL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp REAL NOT NULL
      );
    `);
    run(dbPath, database);
  } finally {
    database.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe("readHermesUsageRecords", () => {
  it("maps canonical Hermes session counters without double-counting cached input", () => {
    withDatabase((dbPath, database) => {
      database
        .prepare(`
          INSERT INTO sessions (
            id, model, started_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens,
            estimated_cost_usd, actual_cost_usd
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run("session-a", "custom/gpt-5.6-sol", 1_786_000_000, 120, 40, 900, 20, 15, 0.25, 0.2);
      database
        .prepare("INSERT INTO messages (session_id, timestamp) VALUES (?, ?)")
        .run("session-a", 1_786_000_500);

      const records = readHermesUsageRecords(dbPath, 0);

      expect(records).toEqual([
        {
          provider: "hermes",
          timestampMs: 1_786_000_500_000,
          model: "custom/gpt-5.6-sol",
          sessionId: "session-a",
          totals: {
            uncachedInputTokens: 120,
            cachedInputTokens: 900,
            cacheCreationTokens: 20,
            outputTokens: 40,
            reasoningTokens: 15,
          },
          reportedCostUsd: 0.2,
          dedupeKey: null,
        },
      ]);
    });
  });

  it("uses estimated cost when actual cost is absent and filters by last activity", () => {
    withDatabase((dbPath, database) => {
      database
        .prepare(`
          INSERT INTO sessions (
            id, model, started_at, ended_at, input_tokens, output_tokens, estimated_cost_usd
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run("old", "model-old", 100, 200, 10, 5, 0.1);
      database
        .prepare(`
          INSERT INTO sessions (
            id, model, started_at, ended_at, input_tokens, output_tokens, estimated_cost_usd
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run("new", "model-new", 300, 400, 20, 6, 0.3);

      const records = readHermesUsageRecords(dbPath, 300_000);

      expect(records).not.toBeNull();
      if (records === null) return;
      expect(records).toHaveLength(1);
      expect(records[0]?.sessionId).toBe("new");
      expect(records[0]?.timestampMs).toBe(400_000);
      expect(records[0]?.reportedCostUsd).toBe(0.3);
    });
  });

  it("skips empty and model-less session rows", () => {
    withDatabase((dbPath, database) => {
      const insert = database.prepare(`
        INSERT INTO sessions (id, model, started_at, input_tokens, output_tokens)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run("empty", "gpt-5.6-sol", 100, 0, 0);
      insert.run("model-less", null, 200, 10, 5);

      expect(readHermesUsageRecords(dbPath, 0)).toEqual([]);
    });
  });
});
