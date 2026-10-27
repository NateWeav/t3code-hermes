import type { HermesKanbanBoardSummary, HermesKanbanTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HERMES_KANBAN_DEFAULT_COLUMNS,
  formatHermesKanbanAge,
  hermesKanbanBoardIconSource,
  hermesKanbanColumnCards,
  hermesKanbanMilestoneView,
  hermesKanbanProgressPercent,
  hermesKanbanStatusLabel,
  hermesKanbanStatusTone,
  sortHermesKanbanBoards,
} from "./hermesKanban.ts";

const task = (id: string, status: string): HermesKanbanTask => ({
  id,
  title: id,
  status,
  assignee: null,
  priority: 0,
  createdAt: "2026-10-26T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  lastActivityAt: "2026-10-26T00:00:00.000Z",
  threadId: null,
  pullRequestUrl: null,
  branch: null,
  commentCount: 0,
});

const board = (
  slug: string,
  blockedCount: number,
  lastActivityAt: string | null,
): HermesKanbanBoardSummary => ({
  slug,
  name: slug,
  description: null,
  icon: null,
  color: null,
  readable: true,
  taskCount: 1,
  doneCount: 0,
  runningCount: 0,
  blockedCount,
  statusCounts: {},
  lastActivityAt,
  projectId: null,
  customIcon: null,
});

describe("hermesKanbanColumnCards", () => {
  it("folds every Hermes status into the four default columns", () => {
    const statuses = [
      "triage",
      "todo",
      "scheduled",
      "ready",
      "running",
      "review",
      "blocked",
      "done",
    ];
    const columns = hermesKanbanColumnCards(statuses.map((status) => task(status, status)));
    expect(columns.map(({ column, tasks }) => [column.id, tasks.map((t) => t.id)])).toEqual([
      ["todo", ["triage", "todo", "scheduled", "ready"]],
      ["in-progress", ["running", "review"]],
      ["blocked", ["blocked"]],
      ["done", ["done"]],
    ]);
  });

  it("keeps cards with an unknown status in a trailing Other column", () => {
    const columns = hermesKanbanColumnCards(
      [task("a", "todo"), task("b", "parked")],
      HERMES_KANBAN_DEFAULT_COLUMNS.slice(0, 1),
    );
    expect(
      columns.map(({ column, tasks }) => [column.label, column.statuses, tasks.length]),
    ).toEqual([
      ["To do", ["triage", "todo", "scheduled", "ready"], 1],
      ["Other", ["parked"], 1],
    ]);
  });
});

describe("sortHermesKanbanBoards", () => {
  it("puts blocked boards first, then the most recently touched", () => {
    const sorted = sortHermesKanbanBoards([
      board("old", 0, "2026-10-01T00:00:00Z"),
      board("never", 0, null),
      board("new", 0, "2026-10-25T00:00:00Z"),
      board("stuck", 2, "2026-09-01T00:00:00Z"),
    ]);
    expect(sorted.map((entry) => entry.slug)).toEqual(["stuck", "new", "old", "never"]);
  });
});

describe("progress and labels", () => {
  it("rounds progress and treats an empty total as zero", () => {
    expect(hermesKanbanProgressPercent(0, 7)).toBe(0);
    expect(hermesKanbanProgressPercent(1, 3)).toBe(33);
    expect(hermesKanbanProgressPercent(3, 3)).toBe(100);
    expect(hermesKanbanProgressPercent(0, 0)).toBe(0);
  });

  it("names statuses and tones them", () => {
    expect(hermesKanbanStatusLabel("todo")).toBe("To do");
    expect(hermesKanbanStatusLabel("ready")).toBe("Ready");
    expect(hermesKanbanStatusTone("review")).toBe("active");
    expect(hermesKanbanStatusTone("blocked")).toBe("blocked");
    expect(hermesKanbanStatusTone("triage")).toBe("waiting");
  });

  it("formats ages relative to now", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(formatHermesKanbanAge(null, now)).toBe("never");
    expect(formatHermesKanbanAge("2026-10-26T11:59:30Z", now)).toBe("just now");
    expect(formatHermesKanbanAge("2026-10-26T11:15:00Z", now)).toBe("45m ago");
    expect(formatHermesKanbanAge("2026-10-26T07:00:00Z", now)).toBe("5h ago");
    expect(formatHermesKanbanAge("2026-10-24T12:00:00Z", now)).toBe("2d ago");
  });
});

describe("hermesKanbanMilestoneView", () => {
  it("resolves features to their milestone cards and skips ids it cannot find", () => {
    const view = hermesKanbanMilestoneView({
      tasks: [task("f", "todo"), task("m1", "done"), task("solo", "ready")],
      features: [{ taskId: "f", milestoneIds: ["m1", "ghost"], doneCount: 1, totalCount: 2 }],
      standaloneIds: ["solo", "ghost"],
    });
    expect(
      view.features.map((feature) => [feature.task.id, feature.milestones.map((m) => m.id)]),
    ).toEqual([["f", ["m1"]]]);
    expect(view.standalone.map((entry) => entry.id)).toEqual(["solo"]);
  });
});

describe("hermesKanbanBoardIconSource", () => {
  const upload = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" as const };
  const exists = (id: string) => id === "p1";
  const PROJECT = "p1" as HermesKanbanBoardSummary["projectId"];
  const GONE = "gone" as HermesKanbanBoardSummary["projectId"];

  it("prefers the upload, then the linked project, then the emoji", () => {
    expect(
      hermesKanbanBoardIconSource({ customIcon: upload, projectId: PROJECT, icon: "🧩" }, exists),
    ).toEqual({ kind: "upload", icon: upload });
    expect(
      hermesKanbanBoardIconSource({ customIcon: null, projectId: PROJECT, icon: "🧩" }, exists),
    ).toEqual({ kind: "project", projectId: "p1" });
    expect(
      hermesKanbanBoardIconSource({ customIcon: null, projectId: null, icon: "🧩" }, exists),
    ).toEqual({ kind: "emoji", emoji: "🧩" });
    expect(
      hermesKanbanBoardIconSource({ customIcon: null, projectId: null, icon: null }, exists),
    ).toEqual({ kind: "none" });
  });

  it("falls through a project that no longer exists to the emoji", () => {
    expect(
      hermesKanbanBoardIconSource({ customIcon: null, projectId: GONE, icon: "🧩" }, exists),
    ).toEqual({ kind: "emoji", emoji: "🧩" });
    expect(
      hermesKanbanBoardIconSource({ customIcon: null, projectId: GONE, icon: "  " }, exists),
    ).toEqual({ kind: "none" });
  });
});
