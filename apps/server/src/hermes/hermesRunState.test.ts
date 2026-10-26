// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { HERMES_STATE_DDL, insertHermesMessage, insertHermesSession } from "./hermesRunFixtures.ts";
import {
  HERMES_COMPRESSION_HANDOFF_SECONDS,
  HERMES_RUN_STALE_AFTER_SECONDS,
  isHermesRunIdle,
  isHermesRunOver,
  parseHermesCronJobSources,
  parseHermesWebhookRoutes,
  readHermesRunChain,
  readHermesRunMessages,
  readHermesRunRoots,
  readHermesSourceRunStats,
  sourceKeyOfSession,
} from "./hermesRunState.ts";

function withStateDb(seed: (db: NodeSqlite.DatabaseSync) => void, run: (dbPath: string) => void) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-runs-"));
  const dbPath = NodePath.join(dir, "state.db");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(HERMES_STATE_DDL);
    seed(db);
  } finally {
    db.close();
  }
  try {
    run(dbPath);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseHermesWebhookRoutes", () => {
  it("reads static routes over agent-created subscriptions of the same name", () => {
    const config = `
platforms:
  webhook:
    enabled: true
    extra:
      routes:
        upstream-sync:
          events: [issues, issue_comment]
          prompt: "Resolve the conflict in {repository.full_name}"
          script: t3code-upstream-conflict.py
`;
    const subscriptions = JSON.stringify({
      "upstream-sync": { events: ["push"], prompt: "shadowed" },
      "deploy-notes": { events: "release", prompt: "Summarise" },
    });
    expect(parseHermesWebhookRoutes(config, subscriptions)).toEqual([
      { name: "deploy-notes", events: ["release"], hint: "Summarise\n\n", scriptPath: null },
      {
        name: "upstream-sync",
        events: ["issues", "issue_comment"],
        hint: "Resolve the conflict in {repository.full_name}\n\nt3code-upstream-conflict.py",
        scriptPath: "t3code-upstream-conflict.py",
      },
    ]);
  });

  it("survives a config it cannot parse", () => {
    expect(parseHermesWebhookRoutes("platforms: [", "{not json")).toEqual([]);
  });
});

describe("parseHermesCronJobSources", () => {
  it("keeps the workdir of a job with a numeric id", () => {
    expect(
      parseHermesCronJobSources({ jobs: [{ id: 7, name: "n", workdir: "/w" }] })[0],
    ).toMatchObject({ id: "7", workdir: "/w" });
  });

  it("keeps the workdir that locates a job's project", () => {
    expect(
      parseHermesCronJobSources({
        jobs: [
          {
            id: "nightly",
            name: "Nightly digest",
            schedule_display: "0 9 * * *",
            workdir: "/w/app",
          },
        ],
      }),
    ).toEqual([
      {
        id: "nightly",
        name: "Nightly digest",
        schedule: "0 9 * * *",
        workdir: "/w/app",
        hint: "\n",
      },
    ]);
  });
});

describe("sourceKeyOfSession", () => {
  it("names webhook runs by route and cron runs by job id", () => {
    expect(
      sourceKeyOfSession({
        id: "s1",
        source: "webhook",
        origin_json: JSON.stringify({ chat_name: "webhook/upstream-sync" }),
      }),
    ).toBe("webhook:upstream-sync");
    expect(
      sourceKeyOfSession({ id: "s2", source: "webhook", origin_json: null, user_id: "webhook:x" }),
    ).toBe("webhook:x");
    expect(sourceKeyOfSession({ id: "cron_job_a_20260930_010203", source: "cron" })).toBe(
      "cron:job_a",
    );
    expect(sourceKeyOfSession({ id: "chat", source: "acp" })).toBeNull();
  });
});

describe("run reads", () => {
  const seed = (db: NodeSqlite.DatabaseSync) => {
    insertHermesSession(db, {
      id: "old-quiet",
      source: "webhook",
      route: "upstream-sync",
      startedAt: 100,
      endedAt: 110,
      endReason: "webhook_complete",
    });
    insertHermesSession(db, {
      id: "old-busy",
      source: "webhook",
      route: "upstream-sync",
      startedAt: 200,
      endedAt: 260,
      endReason: "webhook_complete",
      toolCallCount: 3,
    });
    insertHermesSession(db, {
      id: "new",
      source: "webhook",
      route: "upstream-sync",
      startedAt: 1_000,
      endedAt: 1_100,
      endReason: "compression",
      toolCallCount: 1,
    });
    insertHermesSession(db, {
      id: "new-continued",
      source: "webhook",
      route: "upstream-sync",
      startedAt: 1_100,
      parentSessionId: "new",
    });
    insertHermesSession(db, {
      id: "other-route",
      source: "webhook",
      route: "deploy-notes",
      startedAt: 1_200,
      toolCallCount: 1,
    });
    insertHermesSession(db, { id: "chat", source: "acp", startedAt: 1_300, toolCallCount: 9 });
    insertHermesMessage(db, { sessionId: "new", role: "user", content: "go", timestamp: 1_001 });
    insertHermesMessage(db, {
      sessionId: "new-continued",
      role: "user",
      content: "summary",
      timestamp: 1_101,
      compressedSummary: true,
    });
    insertHermesMessage(db, {
      sessionId: "new-continued",
      role: "assistant",
      content: "done",
      timestamp: 1_102,
    });
  };

  it("lists a source's runs since switching it on, plus its last busy run before", () => {
    withStateDb(seed, (dbPath) => {
      expect(
        readHermesRunRoots(dbPath, "webhook:upstream-sync", 500)?.map((row) => row.id),
      ).toEqual(["old-busy", "new"]);
    });
  });

  it("backfills past a later run that had nothing to report", () => {
    withStateDb(
      (db) => {
        seed(db);
        insertHermesSession(db, {
          id: "old-silent",
          source: "webhook",
          route: "upstream-sync",
          startedAt: 300,
          endedAt: 310,
          endReason: "webhook_complete",
          toolCallCount: 1,
        });
        insertHermesMessage(db, {
          sessionId: "old-silent",
          role: "assistant",
          content: "[SILENT]",
          timestamp: 305,
        });
      },
      (dbPath) => {
        expect(
          readHermesRunRoots(dbPath, "webhook:upstream-sync", 500)?.map((row) => row.id),
        ).toEqual(["old-busy", "new"]);
      },
    );
  });

  it("reads the model a run ran on, provider-qualified when the provider is routable", () => {
    withStateDb(
      (db) => {
        insertHermesSession(db, {
          id: "codex",
          source: "webhook",
          route: "upstream-sync",
          startedAt: 100,
          model: "gpt-5.6-sol",
          billingProvider: "openai-codex",
        });
        insertHermesSession(db, {
          id: "proxy",
          source: "webhook",
          route: "upstream-sync",
          startedAt: 200,
          model: "claude-opus-5-5",
          billingProvider: "custom",
        });
        insertHermesSession(db, {
          id: "unknown",
          source: "webhook",
          route: "upstream-sync",
          startedAt: 300,
        });
      },
      (dbPath) => {
        expect(
          readHermesRunRoots(dbPath, "webhook:upstream-sync", 0)?.map((row) => row.model),
        ).toEqual(["openai-codex:gpt-5.6-sol", "claude-opus-5-5", null]);
      },
    );
  });

  it("follows compression into the continued session and skips its summary", () => {
    withStateDb(seed, (dbPath) => {
      const chain = readHermesRunChain(dbPath, "new");
      expect(chain?.map((row) => row.id)).toEqual(["new", "new-continued"]);
      const messages = readHermesRunMessages(dbPath, ["new", "new-continued"], 0);
      expect(messages?.rows.map((row) => row.content)).toEqual(["go", "done"]);
      const afterFirst = readHermesRunMessages(
        dbPath,
        ["new", "new-continued"],
        messages!.rows[0]!.id,
      );
      expect(afterFirst?.rows.map((row) => row.content)).toEqual(["done"]);
    });
  });

  it("reads each message once when compaction copies it forward under a new id", () => {
    withStateDb(
      (db) => {
        db.exec("ALTER TABLE messages ADD COLUMN message_uid TEXT");
        insertHermesSession(db, {
          id: "run",
          source: "webhook",
          route: "upstream-sync",
          startedAt: 1,
        });
        const insert = db.prepare(
          "INSERT INTO messages (session_id, role, content, timestamp, message_uid) VALUES ('run', ?, ?, ?, ?)",
        );
        insert.run("user", "go", 1, "uid-go");
        insert.run("assistant", "working", 2, "uid-working");
        // Hermes compacts: the summary, then the kept tail re-inserted with the same uids.
        db.prepare(
          "INSERT INTO messages (session_id, role, content, timestamp, _compressed_summary) VALUES ('run', 'user', 'summary', 3, 1)",
        ).run();
        insert.run("user", "go", 1, "uid-go");
        insert.run("assistant", "working", 2, "uid-working");
        insert.run("assistant", "done", 4, "uid-done");
        insert.run("assistant", "legacy", 5, null);
      },
      (dbPath) => {
        expect(readHermesRunMessages(dbPath, ["run"], 0)?.rows.map((row) => row.content)).toEqual([
          "go",
          "working",
          "done",
          "legacy",
        ]);
      },
    );
  });

  it("pages past skipped summary rows instead of stalling on them", () => {
    withStateDb(seed, (dbPath) => {
      // A one-row page holding only the summary still moves the cursor on.
      const first = readHermesRunMessages(dbPath, ["new-continued"], 0, 1);
      expect(first?.rows).toEqual([]);
      expect(first?.full).toBe(true);
      const next = readHermesRunMessages(dbPath, ["new-continued"], first!.lastId, 1);
      expect(next?.rows.map((row) => row.content)).toEqual(["done"]);
    });
  });

  it("keeps a cron job's runs apart from a job whose id extends it", () => {
    withStateDb(
      (db) => {
        insertHermesSession(db, { id: "cron_foo_20260930_010000", source: "cron", startedAt: 10 });
        insertHermesSession(db, {
          id: "cron_foo_bar_20260930_020000",
          source: "cron",
          startedAt: 20,
        });
      },
      (dbPath) => {
        expect(readHermesRunRoots(dbPath, "cron:foo", 0)?.map((row) => row.id)).toEqual([
          "cron_foo_20260930_010000",
        ]);
        expect(readHermesRunRoots(dbPath, "cron:foo_bar", 0)?.map((row) => row.id)).toEqual([
          "cron_foo_bar_20260930_020000",
        ]);
      },
    );
  });

  it("still finds a route's runs when one session's origin is torn", () => {
    withStateDb(
      (db) => {
        seed(db);
        db.prepare("UPDATE sessions SET origin_json = '{not json' WHERE id = 'old-busy'").run();
      },
      (dbPath) => {
        expect(
          readHermesRunRoots(dbPath, "webhook:upstream-sync", 500)?.map((row) => row.id),
        ).toEqual(["old-busy", "new"]);
      },
    );
  });

  it("counts recent runs per source, not continuations or chats", () => {
    withStateDb(seed, (dbPath) => {
      const stats = readHermesSourceRunStats(dbPath, 0);
      expect(Object.fromEntries(stats ?? [])).toEqual({
        "webhook:upstream-sync": { lastRunAt: 1_000, recentRunCount: 2 },
        "webhook:deploy-notes": { lastRunAt: 1_200, recentRunCount: 1 },
      });
    });
  });

  it("returns null rather than throwing when the store is missing", () => {
    expect(readHermesRunRoots("/nonexistent/state.db", "webhook:x", 0)).toBeNull();
  });
});

describe("isHermesRunOver", () => {
  const session = {
    id: "s",
    title: null,
    startedAt: 1_000,
    endedAt: null,
    endReason: null,
    lastActivityAt: null,
    activityDescription: null,
    toolCallCount: 1,
    model: null,
  };

  it("is live until the newest session ends for a reason other than compression", () => {
    expect(isHermesRunOver([session], 1_010, null)).toBe(false);
    expect(
      isHermesRunOver([{ ...session, endedAt: 1_100, endReason: "compression" }], 1_110, null),
    ).toBe(false);
    expect(
      isHermesRunOver([{ ...session, endedAt: 1_100, endReason: "webhook_complete" }], 1_110, null),
    ).toBe(true);
  });

  it("gives up on a compression handoff whose continuation never appeared", () => {
    const handedOff = { ...session, endedAt: 1_100, endReason: "compression" };
    expect(isHermesRunOver([handedOff], 1_100 + HERMES_COMPRESSION_HANDOFF_SECONDS, null)).toBe(
      false,
    );
    expect(isHermesRunOver([handedOff], 1_100 + HERMES_COMPRESSION_HANDOFF_SECONDS + 1, null)).toBe(
      true,
    );
  });

  it("gives up on a run that went quiet without ending", () => {
    expect(isHermesRunOver([session], 1_000 + HERMES_RUN_STALE_AFTER_SECONDS + 1, null)).toBe(true);
    expect(
      isHermesRunOver([session], 1_000 + HERMES_RUN_STALE_AFTER_SECONDS + 1, 1_000 + 3_600),
    ).toBe(false);
  });

  it("reads a run as idle once its turn ends and Hermes clears the activity label", () => {
    const active = { ...session, lastActivityAt: 1_010 };
    expect(isHermesRunIdle([{ ...active, activityDescription: "terminal command running" }])).toBe(
      false,
    );
    expect(isHermesRunIdle([active])).toBe(true);
    // A session that has not reported any activity yet is still starting.
    expect(isHermesRunIdle([session])).toBe(false);
    expect(isHermesRunIdle([{ ...active, endedAt: 1_100, endReason: "compression" }])).toBe(false);
  });
});
