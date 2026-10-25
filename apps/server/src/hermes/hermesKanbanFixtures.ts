// Test fixtures write throwaway Hermes Kanban homes with node:sqlite.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Hermes Kanban homes for tests: the columns T3 reads from `hermes_cli/kanban_db.py`'s schema,
 * laid out the way Hermes stores boards on disk.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const KANBAN_DDL = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
  priority INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
  completed_at INTEGER, result TEXT
);
CREATE TABLE task_links (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (parent_id, child_id));
CREATE TABLE task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, author TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL,
  payload TEXT, created_at INTEGER NOT NULL
);
`;

interface KanbanFixtureTask {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly body?: string | null;
  readonly createdAt?: number;
  readonly completedAt?: number | null;
}

interface KanbanFixtureBoard {
  readonly tasks?: readonly KanbanFixtureTask[];
  /** `[parent, child]`. */
  readonly links?: ReadonlyArray<readonly [string, string]>;
  readonly comments?: ReadonlyArray<{ taskId: string; author: string; body: string; at: number }>;
  readonly events?: ReadonlyArray<{ taskId: string; at: number }>;
}

export function writeKanbanDb(dbPath: string, board: KanbanFixtureBoard): void {
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(KANBAN_DDL);
    for (const [index, task] of (board.tasks ?? []).entries()) {
      db.prepare(
        `INSERT INTO tasks (id, title, body, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.title ?? task.id,
        task.body ?? null,
        task.status ?? "todo",
        task.createdAt ?? 1_000 + index,
        task.completedAt ?? null,
      );
    }
    for (const [parent, child] of board.links ?? []) {
      db.prepare(`INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)`).run(parent, child);
    }
    for (const comment of board.comments ?? []) {
      db.prepare(
        `INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)`,
      ).run(comment.taskId, comment.author, comment.body, comment.at);
    }
    for (const event of board.events ?? []) {
      db.prepare(`INSERT INTO task_events (task_id, kind, created_at) VALUES (?, 'x', ?)`).run(
        event.taskId,
        event.at,
      );
    }
  } finally {
    db.close();
  }
}

export function writeKanbanBoard(
  home: string,
  slug: string,
  meta: Record<string, unknown> | null,
  board: KanbanFixtureBoard,
): void {
  const dir = NodePath.join(home, "kanban", "boards", slug);
  NodeFS.mkdirSync(dir, { recursive: true });
  if (meta !== null) NodeFS.writeFileSync(NodePath.join(dir, "board.json"), JSON.stringify(meta));
  writeKanbanDb(NodePath.join(dir, "kanban.db"), board);
}

export function makeKanbanHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-kanban-"));
}
