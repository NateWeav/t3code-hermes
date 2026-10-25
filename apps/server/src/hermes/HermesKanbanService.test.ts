// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HermesKanbanService, layer } from "./HermesKanbanService.ts";
import { makeKanbanHome, writeKanbanBoard, writeKanbanDb } from "./hermesKanbanFixtures.ts";

const THREAD = "5c4e42e2-6ff3-464b-98d9-3ae05234a614";

function kanbanHome() {
  const root = makeKanbanHome();
  // The default board exists but is empty, as on a fresh Hermes install.
  writeKanbanDb(NodePath.join(root, "kanban.db"), {});
  writeKanbanBoard(
    root,
    "t3code",
    { name: "T3 Fork", description: "Fork features", icon: "🧩", color: "#8b5cf6" },
    {
      tasks: [
        {
          id: "t_feature",
          title: "Kanban board surface",
          body: `Overview.\nT3-Thread: t3-thread://v1/${THREAD}\nBranch: feat/hermes-kanban-board`,
        },
        { id: "t_read", title: "Read service", status: "done", completedAt: 1_100 },
        { id: "t_ui", title: "Board surface", status: "blocked" },
        { id: "t_note", title: "Loose note", status: "running" },
      ],
      links: [
        ["t_read", "t_feature"],
        ["t_ui", "t_feature"],
      ],
      comments: [{ taskId: "t_feature", author: "aeris", body: "Started.", at: 1_200 }],
      events: [{ taskId: "t_ui", at: 1_300 }],
    },
  );
  writeKanbanBoard(root, "broken", { name: "Broken" }, {});
  NodeFS.writeFileSync(NodePath.join(root, "kanban", "boards", "broken", "kanban.db"), "garbage");
  return root;
}

const serviceWith = (
  settings: Parameters<typeof ServerSettings.layerTest>[0],
  baseDir: string | { readonly prefix: string } = { prefix: "t3-hermes-kanban-" },
) =>
  layer.pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const hermesAt = (root: string) => ({
  providerInstances: {
    [ProviderInstanceId.make("hermes")]: {
      driver: ProviderDriverKind.make("hermes"),
      enabled: true,
      environment: [{ name: "HERMES_HOME", value: root, sensitive: false }],
    },
  },
});

it.effect("lists live boards with counts and hides the empty default board", () => {
  const root = kanbanHome();
  return Effect.gen(function* () {
    const kanban = yield* HermesKanbanService;
    const result = yield* kanban.listBoards;
    expect(result.availability).toBe("ready");
    expect(result.boards.map((board) => board.slug)).toEqual(["broken", "t3code"]);
    expect(result.boards[0]).toMatchObject({ readable: false, taskCount: 0 });
    expect(result.boards[1]).toMatchObject({
      name: "T3 Fork",
      icon: "🧩",
      readable: true,
      taskCount: 4,
      doneCount: 1,
      runningCount: 1,
      blockedCount: 1,
      statusCounts: { todo: 1, done: 1, blocked: 1, running: 1 },
      lastActivityAt: "1970-01-01T00:21:40.000Z",
    });
  }).pipe(
    Effect.provide(serviceWith(hermesAt(root))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("reads a board's milestone structure and one card's comments", () => {
  const root = kanbanHome();
  return Effect.gen(function* () {
    const kanban = yield* HermesKanbanService;
    const board = yield* kanban.getBoard({ slug: "t3code" });
    expect(board).toMatchObject({
      availability: "ready",
      features: [
        { taskId: "t_feature", milestoneIds: ["t_read", "t_ui"], doneCount: 1, totalCount: 2 },
      ],
      standaloneIds: ["t_note"],
    });
    expect(board.tasks[0]).toMatchObject({
      id: "t_feature",
      threadId: THREAD,
      branch: "feat/hermes-kanban-board",
      pullRequestUrl: null,
      commentCount: 1,
    });
    const task = yield* kanban.getTask({ slug: "t3code", taskId: "t_feature" });
    expect(task).toMatchObject({
      availability: "ready",
      task: { id: "t_feature", parentIds: ["t_read", "t_ui"], childIds: [] },
      comments: [{ author: "aeris", body: "Started.", createdAt: "1970-01-01T00:20:00.000Z" }],
    });
    expect(task.task?.body).toContain("Overview.");

    expect(yield* kanban.getBoard({ slug: "missing" })).toMatchObject({
      availability: "ready",
      board: null,
    });
    expect(yield* kanban.getBoard({ slug: "broken" })).toMatchObject({
      availability: "unavailable",
      board: { slug: "broken", readable: false },
    });
    expect(yield* kanban.getTask({ slug: "t3code", taskId: "nope" })).toMatchObject({
      availability: "ready",
      task: null,
    });
  }).pipe(
    Effect.provide(serviceWith(hermesAt(root))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("answers hermes-off without touching any board while Hermes is disabled", () =>
  Effect.gen(function* () {
    const kanban = yield* HermesKanbanService;
    expect(yield* kanban.listBoards).toEqual({ availability: "hermes-off", boards: [] });
    expect(yield* kanban.getBoard({ slug: "t3code" })).toMatchObject({
      availability: "hermes-off",
      tasks: [],
    });
    expect(yield* kanban.getTask({ slug: "t3code", taskId: "x" })).toMatchObject({
      availability: "hermes-off",
      task: null,
    });
  }).pipe(Effect.provide(serviceWith({}))),
);

const PROJECT = ProjectId.make("project-kanban");
const PNG_ICON = {
  dataUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64")}`,
  mimeType: "image/png" as const,
};

it.effect("starts every board with no T3 preferences, exactly as Hermes has it", () => {
  const root = kanbanHome();
  return Effect.gen(function* () {
    const kanban = yield* HermesKanbanService;
    const listed = yield* kanban.listBoards;
    for (const board of listed.boards) {
      expect(board).toMatchObject({ projectId: null, customIcon: null });
    }
    expect((yield* kanban.getBoard({ slug: "t3code" })).board).toMatchObject({
      icon: "🧩",
      projectId: null,
      customIcon: null,
    });
  }).pipe(
    Effect.provide(serviceWith(hermesAt(root))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("stores a board's project and icon in T3 state and survives a restart", () => {
  const root = kanbanHome();
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(root), "t3-base-"));
  const boardJson = NodePath.join(root, "kanban", "boards", "t3code", "board.json");
  const boardBefore = NodeFS.readFileSync(boardJson, "utf8");
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const kanban = yield* HermesKanbanService;
      expect(yield* kanban.setBoardProject({ slug: "t3code", projectId: PROJECT })).toEqual({
        slug: "t3code",
        projectId: PROJECT,
        customIcon: null,
      });
      expect(yield* kanban.setBoardIcon({ slug: "t3code", icon: PNG_ICON })).toEqual({
        slug: "t3code",
        projectId: PROJECT,
        customIcon: PNG_ICON,
      });
    }).pipe(Effect.provide(serviceWith(hermesAt(root), baseDir)));

    // A fresh service instance reads the file back at boot.
    yield* Effect.gen(function* () {
      const kanban = yield* HermesKanbanService;
      const listed = yield* kanban.listBoards;
      expect(listed.boards.find((board) => board.slug === "t3code")).toMatchObject({
        icon: "🧩",
        projectId: PROJECT,
        customIcon: PNG_ICON,
      });
      expect(listed.boards.find((board) => board.slug === "broken")).toMatchObject({
        projectId: null,
        customIcon: null,
      });
      expect((yield* kanban.getBoard({ slug: "t3code" })).board).toMatchObject({
        projectId: PROJECT,
        customIcon: PNG_ICON,
      });

      // Clearing one field keeps the other; clearing both drops the entry.
      expect(yield* kanban.setBoardIcon({ slug: "t3code", icon: null })).toEqual({
        slug: "t3code",
        projectId: PROJECT,
        customIcon: null,
      });
      expect(yield* kanban.setBoardProject({ slug: "t3code", projectId: null })).toEqual({
        slug: "t3code",
        projectId: null,
        customIcon: null,
      });
    }).pipe(Effect.provide(serviceWith(hermesAt(root), baseDir)));

    const stored = JSON.parse(
      NodeFS.readFileSync(NodePath.join(baseDir, "userdata", "hermes-kanban-boards.json"), "utf8"),
    );
    expect(stored).toEqual({ version: 1, boards: {} });
    // Hermes's own files are never written.
    expect(NodeFS.readFileSync(boardJson, "utf8")).toBe(boardBefore);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("rejects unknown boards, bad image types, and oversized icons", () => {
  const root = kanbanHome();
  return Effect.gen(function* () {
    const kanban = yield* HermesKanbanService;
    const unknown = yield* kanban
      .setBoardProject({ slug: "missing", projectId: PROJECT })
      .pipe(Effect.flip);
    expect(unknown.reason).toBe("unknownBoard");
    const unknownIcon = yield* kanban
      .setBoardIcon({ slug: "missing", icon: null })
      .pipe(Effect.flip);
    expect(unknownIcon.reason).toBe("unknownBoard");

    const mismatched = yield* kanban
      .setBoardIcon({
        slug: "t3code",
        icon: { dataUrl: "data:text/html;base64,PHNjcmlwdD4=", mimeType: "image/png" },
      })
      .pipe(Effect.flip);
    expect(mismatched.reason).toBe("invalidIcon");

    const notPng = yield* kanban
      .setBoardIcon({
        slug: "t3code",
        icon: { dataUrl: "data:image/png;base64,PHN2Zz4=", mimeType: "image/png" },
      })
      .pipe(Effect.flip);
    expect(notPng.reason).toBe("invalidIcon");

    const big = Buffer.alloc(256 * 1024 + 16);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const oversized = yield* kanban
      .setBoardIcon({
        slug: "t3code",
        icon: { dataUrl: `data:image/png;base64,${big.toString("base64")}`, mimeType: "image/png" },
      })
      .pipe(Effect.flip);
    expect(oversized.reason).toBe("invalidIcon");

    // Nothing was stored by the refused calls.
    expect((yield* kanban.getBoard({ slug: "t3code" })).board).toMatchObject({
      projectId: null,
      customIcon: null,
    });
  }).pipe(
    Effect.provide(serviceWith(hermesAt(root))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
});

it.effect("refuses board preferences while Hermes is disabled", () =>
  Effect.gen(function* () {
    const kanban = yield* HermesKanbanService;
    const error = yield* kanban
      .setBoardProject({ slug: "t3code", projectId: PROJECT })
      .pipe(Effect.flip);
    expect(error.reason).toBe("providerDisabled");
  }).pipe(Effect.provide(serviceWith({}))),
);
