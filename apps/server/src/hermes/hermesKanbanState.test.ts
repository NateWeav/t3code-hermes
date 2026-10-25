// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  countHermesKanbanTasks,
  deriveHermesKanbanStructure,
  findHermesKanbanBoard,
  listHermesKanbanBoards,
  parseHermesKanbanBody,
  readHermesKanbanBoardRows,
  readHermesKanbanComments,
  resolveHermesKanbanHome,
} from "./hermesKanbanState.ts";
import { makeKanbanHome, writeKanbanBoard, writeKanbanDb } from "./hermesKanbanFixtures.ts";

const homes: string[] = [];
function home(): string {
  const root = makeKanbanHome();
  homes.push(root);
  return root;
}
afterEach(() => {
  for (const root of homes.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("resolveHermesKanbanHome", () => {
  it("shares the root home across profiles and honours HERMES_KANBAN_HOME", () => {
    expect(resolveHermesKanbanHome("/h/.hermes", {}, "/h")).toBe("/h/.hermes");
    expect(resolveHermesKanbanHome("/h/.hermes/profiles/work", {}, "/h")).toBe("/h/.hermes");
    expect(resolveHermesKanbanHome("/h/.hermes", { HERMES_KANBAN_HOME: "~/kb" }, "/h")).toBe(
      "/h/kb",
    );
  });
});

describe("listHermesKanbanBoards", () => {
  it("lists default first, then boards with a board.json, skipping stubs and archived boards", () => {
    const root = home();
    writeKanbanDb(NodePath.join(root, "kanban.db"), {});
    writeKanbanBoard(root, "t3code", { name: "T3 Fork", icon: "🧩", color: "#8b5cf6" }, {});
    writeKanbanBoard(root, "atm10-server", {}, {});
    writeKanbanBoard(root, "stub", null, {});
    writeKanbanBoard(root, "old", { name: "Old", archived: true }, {});
    writeKanbanBoard(root, "_archived", { name: "Gone" }, {});
    const boards = listHermesKanbanBoards(root);
    expect(boards.map((board) => [board.slug, board.name])).toEqual([
      ["default", "Default"],
      ["atm10-server", "Atm10 Server"],
      ["t3code", "T3 Fork"],
    ]);
    expect(boards[2]).toMatchObject({ icon: "🧩", color: "#8b5cf6", description: null });
  });

  it("never creates a database and reads a missing home as no boards", () => {
    const root = home();
    expect(listHermesKanbanBoards(root)).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(root, "kanban.db"))).toBe(false);
    expect(listHermesKanbanBoards(NodePath.join(root, "missing"))).toEqual([]);
  });

  it("rejects slugs that could leave the boards directory", () => {
    const root = home();
    writeKanbanBoard(root, "real", {}, {});
    expect(findHermesKanbanBoard(root, "real")?.slug).toBe("real");
    for (const slug of ["../real", "Real", "_archived", "", "a/b"]) {
      expect(findHermesKanbanBoard(root, slug)).toBeNull();
    }
  });
});

describe("readHermesKanbanBoardRows", () => {
  it("leaves archived cards and their links out and dates activity by the newest event", () => {
    const root = home();
    const dbPath = NodePath.join(root, "kanban.db");
    writeKanbanDb(dbPath, {
      tasks: [
        { id: "m1", status: "done", completedAt: 1_500 },
        { id: "f", body: "PR: https://github.com/a/b/pull/1" },
        { id: "gone", status: "archived" },
      ],
      links: [
        ["m1", "f"],
        ["gone", "f"],
      ],
      comments: [{ taskId: "f", author: "nick", body: "note", at: 2_000 }],
      events: [
        { taskId: "f", at: 3_000 },
        { taskId: "gone", at: 4_000 },
      ],
    });
    const rows = readHermesKanbanBoardRows(dbPath);
    expect(rows?.tasks.map((task) => [task.id, task.lastActivityAt, task.commentCount])).toEqual([
      ["m1", 1_500, 0],
      ["f", 3_000, 1],
    ]);
    expect(rows?.links).toEqual([{ parentId: "m1", childId: "f" }]);
    expect(rows?.lastEventAt).toBe(4_000);
    expect(readHermesKanbanComments(dbPath, "f")).toEqual([
      { id: 1, author: "nick", body: "note", createdAt: 2_000 },
    ]);
  });

  it("reads a missing or foreign database as unavailable without creating it", () => {
    const root = home();
    const missing = NodePath.join(root, "nope.db");
    expect(readHermesKanbanBoardRows(missing)).toBeNull();
    expect(readHermesKanbanComments(missing, "x")).toBeNull();
    expect(NodeFS.existsSync(missing)).toBe(false);
    const foreign = NodePath.join(root, "foreign.db");
    NodeFS.writeFileSync(foreign, "not sqlite");
    expect(readHermesKanbanBoardRows(foreign)).toBeNull();
  });
});

describe("deriveHermesKanbanStructure", () => {
  it("treats link children as features whose parents are milestones", () => {
    const tasks = [
      { id: "feature", status: "todo" },
      { id: "m1", status: "done" },
      { id: "m2", status: "ready" },
      { id: "lonely", status: "running" },
    ];
    const structure = deriveHermesKanbanStructure(tasks, [
      { parentId: "m2", childId: "feature" },
      { parentId: "m1", childId: "feature" },
    ]);
    expect(structure).toEqual({
      features: [{ taskId: "feature", milestoneIds: ["m1", "m2"], doneCount: 1, totalCount: 2 }],
      standaloneIds: ["lonely"],
    });
  });

  it("ignores links to unlisted cards", () => {
    expect(
      deriveHermesKanbanStructure([{ id: "a", status: "todo" }], [{ parentId: "x", childId: "a" }]),
    ).toEqual({ features: [], standaloneIds: ["a"] });
  });
});

describe("parseHermesKanbanBody", () => {
  it("reads thread, PR, and branch lines and leaves other text alone", () => {
    expect(
      parseHermesKanbanBody(
        "Notes first.\nT3-Thread: t3-thread://v1/5c4e42e2-6ff3\nPR: https://github.com/a/b/pull/7\nBranch: feat/x\n",
      ),
    ).toEqual({
      threadId: "5c4e42e2-6ff3",
      pullRequestUrl: "https://github.com/a/b/pull/7",
      branch: "feat/x",
    });
    expect(parseHermesKanbanBody("PR: not a url\nbranch talk")).toEqual({
      threadId: null,
      pullRequestUrl: null,
      branch: null,
    });
    expect(parseHermesKanbanBody(null).threadId).toBeNull();
  });
});

describe("countHermesKanbanTasks", () => {
  it("counts per status with done, running, and blocked broken out", () => {
    expect(
      countHermesKanbanTasks([
        { status: "done" },
        { status: "running" },
        { status: "blocked" },
        { status: "todo" },
        { status: "todo" },
      ]),
    ).toEqual({
      taskCount: 5,
      doneCount: 1,
      runningCount: 1,
      blockedCount: 1,
      statusCounts: { done: 1, running: 1, blocked: 1, todo: 2 },
    });
  });
});
