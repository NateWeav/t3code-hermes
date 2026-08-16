// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { readOpenCodeUsageRecords } from "./usageOpenCode.ts";

function withDatabase(run: (path: string, database: NodeSqlite.DatabaseSync) => void): void {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-"));
  const dbPath = NodePath.join(dir, "opencode.db");
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    run(dbPath, database);
  } finally {
    database.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe("readOpenCodeUsageRecords", () => {
  it("uses OpenCode's provider-aware cost and token breakdown", () => {
    withDatabase((dbPath, database) => {
      database
        .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
        .run(
          "msg-kimi",
          "ses-kimi",
          1_786_000_000_000,
          JSON.stringify({
            role: "assistant",
            providerID: "opencode-go",
            modelID: "kimi-k3",
            time: { created: 1_786_000_000_000, completed: 1_786_000_005_000 },
            cost: 0.42,
            tokens: {
              input: 120,
              output: 40,
              reasoning: 15,
              cache: { read: 900, write: 20 },
            },
          }),
        );

      expect(readOpenCodeUsageRecords(dbPath, 0)).toEqual([
        {
          provider: "opencode",
          timestampMs: 1_786_000_005_000,
          model: "opencode-go/kimi-k3",
          sessionId: "ses-kimi",
          totals: {
            uncachedInputTokens: 120,
            cachedInputTokens: 900,
            cacheCreationTokens: 20,
            outputTokens: 40,
            reasoningTokens: 15,
          },
          reportedCostUsd: 0.42,
          dedupeKey: "opencode:msg-kimi",
        },
      ]);
    });
  });

  it("ignores unfinished and empty assistant messages", () => {
    withDatabase((dbPath, database) => {
      const insert = database.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
      );
      insert.run(
        "unfinished",
        "session-a",
        100,
        JSON.stringify({
          role: "assistant",
          providerID: "opencode-go",
          modelID: "kimi-k3",
          time: { created: 100 },
          cost: 1,
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
      insert.run(
        "empty",
        "session-a",
        200,
        JSON.stringify({
          role: "assistant",
          providerID: "opencode-go",
          modelID: "kimi-k3",
          time: { created: 200, completed: 250 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );

      expect(readOpenCodeUsageRecords(dbPath, 0)).toEqual([]);
    });
  });
});
