// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

const serviceWith = (settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  layer.pipe(Layer.provide(ServerSettings.layerTest(settings)), Layer.provide(NodeServices.layer));

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
