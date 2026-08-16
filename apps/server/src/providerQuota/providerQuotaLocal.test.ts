// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { parseClaudeNativeCredentials, readOpenCodeGoLocalQuota } from "./providerQuotaLocal.ts";

describe("provider quota native stores", () => {
  it("reads Claude Code's native OAuth credential shape", () => {
    expect(
      parseClaudeNativeCredentials({
        claudeAiOauth: {
          accessToken: "oauth-token",
          subscriptionType: "pro",
          refreshToken: "not-returned",
        },
      }),
    ).toEqual({ accessToken: "oauth-token", planLabel: "pro" });
    expect(parseClaudeNativeCredentials({ mcpOAuth: {} })).toBeNull();
  });

  it("estimates OpenCode Go windows from the signed-in CLI's local history", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-quota-"));
    const authPath = NodePath.join(directory, "auth.json");
    const databasePath = NodePath.join(directory, "opencode.db");
    const nowMs = DateTime.makeUnsafe("2026-08-16T12:00:00.000Z").epochMilliseconds;
    NodeFS.writeFileSync(
      authPath,
      JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
      { mode: 0o600 },
    );
    const database = new NodeSqlite.DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      database
        .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
        .run(
          "message-1",
          "session-1",
          nowMs - 60 * 60 * 1000,
          JSON.stringify({
            role: "assistant",
            providerID: "opencode-go",
            time: { created: nowMs - 60 * 60 * 1000 },
            cost: 6,
          }),
        );

      const quota = readOpenCodeGoLocalQuota({ authPath, databasePath, nowMs });
      expect(quota.authenticated).toBe(true);
      expect(quota.windows).toMatchObject([
        { id: "five-hour", usedPercent: 50 },
        { id: "weekly", usedPercent: 20 },
        { id: "monthly", usedPercent: 10 },
      ]);
    } finally {
      database.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes a signed-in OpenCode account with no local history", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-quota-"));
    const authPath = NodePath.join(directory, "auth.json");
    const databasePath = NodePath.join(directory, "opencode.db");
    NodeFS.writeFileSync(authPath, JSON.stringify({ "opencode-go": { key: "go-key" } }));
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
    );
    database.close();
    try {
      expect(readOpenCodeGoLocalQuota({ authPath, databasePath, nowMs: 0 })).toEqual({
        authenticated: true,
        windows: [],
      });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
