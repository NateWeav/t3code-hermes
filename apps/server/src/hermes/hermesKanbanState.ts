// Hermes's kanban.db files are read with node:sqlite's synchronous read-only API, like state.db.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Readers for Hermes Kanban boards: `default` at `<root>/kanban.db`, the rest at
 * `kanban/boards/<slug>/kanban.db`, a board only while its `board.json` exists (Hermes's rule).
 * Read-only: a missing, locked, or foreign database reads as null and is never created.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { withStateDb } from "./hermesRunState.ts";

export const HERMES_KANBAN_DEFAULT_BOARD = "default";
const BOARD_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ARCHIVED_STATUS = "archived";

function isHermesKanbanBoardSlug(slug: string): boolean {
  return BOARD_SLUG.test(slug);
}

/**
 * Hermes keeps boards in the root home, shared by every profile: `HERMES_KANBAN_HOME` when set,
 * else the Hermes home with any `profiles/<name>` suffix removed.
 */
export function resolveHermesKanbanHome(
  hermesHome: string,
  environment: NodeJS.ProcessEnv = process.env,
  homedir: string = NodeOS.homedir(),
): string {
  const override = environment["HERMES_KANBAN_HOME"]?.trim();
  if (override) {
    if (override === "~") return homedir;
    return override.startsWith("~/") ? NodePath.join(homedir, override.slice(2)) : override;
  }
  const normalized = NodePath.normalize(hermesHome);
  const parent = NodePath.dirname(normalized);
  return NodePath.basename(parent) === "profiles" ? NodePath.dirname(parent) : normalized;
}

export interface HermesKanbanBoardEntry {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly icon: string | null;
  readonly color: string | null;
  readonly dbPath: string;
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `atm10-server` -> `Atm10 Server`, Hermes's name for a board without one. */
function defaultBoardName(slug: string): string {
  return (
    slug
      .replace(/_/g, "-")
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || slug
  );
}

function readBoardJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    // A malformed board.json still marks a board; Hermes falls back to defaults the same way.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : {};
  }
}

function entryFrom(
  slug: string,
  dbPath: string,
  meta: Record<string, unknown>,
): HermesKanbanBoardEntry {
  return {
    slug,
    name:
      nonBlank(meta["name"]) ??
      (slug === HERMES_KANBAN_DEFAULT_BOARD ? "Default" : defaultBoardName(slug)),
    description: nonBlank(meta["description"]),
    icon: nonBlank(meta["icon"]),
    color: nonBlank(meta["color"]),
    dbPath,
  };
}

function defaultBoardEntry(kanbanHome: string): HermesKanbanBoardEntry | null {
  const dbPath = NodePath.join(kanbanHome, "kanban.db");
  if (!NodeFS.existsSync(dbPath)) return null;
  const meta =
    readBoardJson(
      NodePath.join(kanbanHome, "kanban", "boards", HERMES_KANBAN_DEFAULT_BOARD, "board.json"),
    ) ?? {};
  return entryFrom(HERMES_KANBAN_DEFAULT_BOARD, dbPath, meta);
}

function namedBoardEntry(kanbanHome: string, slug: string): HermesKanbanBoardEntry | null {
  if (slug === HERMES_KANBAN_DEFAULT_BOARD || !isHermesKanbanBoardSlug(slug)) return null;
  const dir = NodePath.join(kanbanHome, "kanban", "boards", slug);
  const meta = readBoardJson(NodePath.join(dir, "board.json"));
  if (meta === null || meta["archived"] === true) return null;
  const dbPath = NodePath.join(dir, "kanban.db");
  return NodeFS.existsSync(dbPath) ? entryFrom(slug, dbPath, meta) : null;
}

/**
 * Every live board: `default` first when its database exists, then each `kanban/boards/<slug>/`
 * holding a `board.json` that is not archived, by slug. `_archived/` never matches the slug rule.
 */
export function listHermesKanbanBoards(kanbanHome: string): readonly HermesKanbanBoardEntry[] {
  const entries: HermesKanbanBoardEntry[] = [];
  const fallback = defaultBoardEntry(kanbanHome);
  if (fallback !== null) entries.push(fallback);
  let names: string[];
  try {
    names = NodeFS.readdirSync(NodePath.join(kanbanHome, "kanban", "boards"));
  } catch {
    return entries;
  }
  for (const name of names.toSorted()) {
    const entry = namedBoardEntry(kanbanHome, name);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** One live board by slug, without listing the rest. The slug is validated before any path join. */
export function findHermesKanbanBoard(
  kanbanHome: string,
  slug: string,
): HermesKanbanBoardEntry | null {
  if (!isHermesKanbanBoardSlug(slug)) return null;
  return slug === HERMES_KANBAN_DEFAULT_BOARD
    ? defaultBoardEntry(kanbanHome)
    : namedBoardEntry(kanbanHome, slug);
}

export interface HermesKanbanTaskRow {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly assignee: string | null;
  readonly status: string;
  readonly priority: number;
  /** Seconds. */
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly result: string | null;
  /** Seconds: the task's newest event, else its newest timestamp. */
  readonly lastActivityAt: number;
  readonly commentCount: number;
}

interface HermesKanbanLinkRow {
  readonly parentId: string;
  readonly childId: string;
}

export interface HermesKanbanBoardRows {
  /** Oldest first, archived left out. */
  readonly tasks: readonly HermesKanbanTaskRow[];
  /** Only links whose both ends are listed. */
  readonly links: readonly HermesKanbanLinkRow[];
  /** Seconds; the newest event on the board, archived cards' included. */
  readonly lastEventAt: number | null;
}

interface HermesKanbanCommentRow {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  /** Seconds. */
  readonly createdAt: number;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

type Row = Record<string, unknown>;

/** The board's cards and links. Null when the database is missing, locked, or not a board. */
export function readHermesKanbanBoardRows(dbPath: string): HermesKanbanBoardRows | null {
  if (!NodeFS.existsSync(dbPath)) return null;
  return withStateDb(dbPath, (db) => {
    const lastEvents = new Map<string, number>();
    for (const row of db
      .prepare(`SELECT task_id, MAX(created_at) AS at FROM task_events GROUP BY task_id`)
      .all() as unknown as Row[]) {
      const at = seconds(row["at"]);
      if (typeof row["task_id"] === "string" && at !== null) lastEvents.set(row["task_id"], at);
    }
    const commentCounts = new Map<string, number>();
    for (const row of db
      .prepare(`SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id`)
      .all() as unknown as Row[]) {
      if (typeof row["task_id"] === "string") commentCounts.set(row["task_id"], Number(row["n"]));
    }
    const tasks: HermesKanbanTaskRow[] = [];
    for (const row of db
      .prepare(
        `SELECT id, title, body, assignee, status, priority, created_at, started_at,
                completed_at, result
         FROM tasks WHERE status != ? ORDER BY created_at, id`,
      )
      .all(ARCHIVED_STATUS) as unknown as Row[]) {
      const id = text(row["id"]);
      const status = text(row["status"])?.trim();
      const createdAt = seconds(row["created_at"]);
      if (!id || !status || createdAt === null) continue;
      const startedAt = seconds(row["started_at"]);
      const completedAt = seconds(row["completed_at"]);
      tasks.push({
        id,
        title: text(row["title"]) ?? "",
        body: text(row["body"]),
        assignee: text(row["assignee"]),
        status,
        priority: Number.isInteger(row["priority"]) ? (row["priority"] as number) : 0,
        createdAt,
        startedAt,
        completedAt,
        result: text(row["result"]),
        lastActivityAt: lastEvents.get(id) ?? Math.max(createdAt, startedAt ?? 0, completedAt ?? 0),
        commentCount: commentCounts.get(id) ?? 0,
      });
    }
    const listed = new Set(tasks.map((task) => task.id));
    const links: HermesKanbanLinkRow[] = [];
    for (const row of db
      .prepare(`SELECT parent_id, child_id FROM task_links ORDER BY rowid`)
      .all() as unknown as Row[]) {
      const parentId = text(row["parent_id"]);
      const childId = text(row["child_id"]);
      if (parentId && childId && listed.has(parentId) && listed.has(childId)) {
        links.push({ parentId, childId });
      }
    }
    const lastEventAt = lastEvents.size === 0 ? null : Math.max(...lastEvents.values());
    return { tasks, links, lastEventAt };
  });
}

/** One card's comments, oldest first. Null when the database cannot be read. */
export function readHermesKanbanComments(
  dbPath: string,
  taskId: string,
): readonly HermesKanbanCommentRow[] | null {
  if (!NodeFS.existsSync(dbPath)) return null;
  return withStateDb(dbPath, (db) =>
    (
      db
        .prepare(
          `SELECT id, author, body, created_at FROM task_comments
           WHERE task_id = ? ORDER BY created_at, id`,
        )
        .all(taskId) as unknown as Row[]
    ).flatMap((row) => {
      const id = seconds(row["id"]);
      const createdAt = seconds(row["created_at"]);
      if (id === null || createdAt === null) return [];
      return [{ id, author: text(row["author"]) ?? "", body: text(row["body"]) ?? "", createdAt }];
    }),
  );
}

interface HermesKanbanBodyFields {
  readonly threadId: string | null;
  readonly pullRequestUrl: string | null;
  readonly branch: string | null;
}

const THREAD_LINE = /^\s*T3-Thread:\s*t3-thread:\/\/v1\/(\S+)\s*$/im;
const PR_LINE = /^\s*PR:\s*(https?:\/\/\S+)\s*$/im;
const BRANCH_LINE = /^\s*Branch:\s*(\S+)\s*$/im;

/** The `T3-Thread:`, `PR:`, and `Branch:` lines tracker cards carry in their body; first wins. */
export function parseHermesKanbanBody(body: string | null): HermesKanbanBodyFields {
  if (body === null) return { threadId: null, pullRequestUrl: null, branch: null };
  return {
    threadId: THREAD_LINE.exec(body)?.[1] ?? null,
    pullRequestUrl: PR_LINE.exec(body)?.[1] ?? null,
    branch: BRANCH_LINE.exec(body)?.[1] ?? null,
  };
}

interface HermesKanbanFeatureRow {
  readonly taskId: string;
  readonly milestoneIds: readonly string[];
  readonly doneCount: number;
  readonly totalCount: number;
}

interface HermesKanbanStructure {
  /** In task order. */
  readonly features: readonly HermesKanbanFeatureRow[];
  /** Cards that are neither a feature nor one of its milestones, in task order. */
  readonly standaloneIds: readonly string[];
}

/**
 * Milestones are a feature's parents: Hermes links `milestone -> feature`, so the feature waits on
 * them. Any child of a link is a feature, and its progress is its done parents over all parents.
 */
export function deriveHermesKanbanStructure(
  tasks: readonly Pick<HermesKanbanTaskRow, "id" | "status">[],
  links: readonly HermesKanbanLinkRow[],
): HermesKanbanStructure {
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  const parents = new Map<string, string[]>();
  for (const link of links) {
    if (!order.has(link.parentId) || !order.has(link.childId)) continue;
    const list = parents.get(link.childId) ?? [];
    if (!list.includes(link.parentId)) list.push(link.parentId);
    parents.set(link.childId, list);
  }
  const inFeature = new Set<string>();
  const features: HermesKanbanFeatureRow[] = [];
  for (const task of tasks) {
    const milestoneIds = parents.get(task.id);
    if (milestoneIds === undefined) continue;
    const sorted = milestoneIds.toSorted((a, b) => order.get(a)! - order.get(b)!);
    inFeature.add(task.id);
    for (const id of sorted) inFeature.add(id);
    features.push({
      taskId: task.id,
      milestoneIds: sorted,
      doneCount: sorted.filter((id) => status.get(id) === "done").length,
      totalCount: sorted.length,
    });
  }
  return {
    features,
    standaloneIds: tasks.filter((task) => !inFeature.has(task.id)).map((task) => task.id),
  };
}

interface HermesKanbanCounts {
  readonly taskCount: number;
  readonly doneCount: number;
  readonly runningCount: number;
  readonly blockedCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
}

export function countHermesKanbanTasks(
  tasks: readonly Pick<HermesKanbanTaskRow, "status">[],
): HermesKanbanCounts {
  const statusCounts: Record<string, number> = {};
  for (const task of tasks) statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
  return {
    taskCount: tasks.length,
    doneCount: statusCounts["done"] ?? 0,
    runningCount: statusCounts["running"] ?? 0,
    blockedCount: statusCounts["blocked"] ?? 0,
    statusCounts,
  };
}
