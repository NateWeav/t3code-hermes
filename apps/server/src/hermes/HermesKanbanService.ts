/**
 * Read-only views of Hermes Kanban boards, read on demand from each board's `kanban.db`. Nothing
 * is cached, nothing can move or dispatch a card, and reads never fail: an unreadable home or
 * board comes back as `availability` or `readable: false`.
 */
import type {
  HermesKanbanBoard,
  HermesKanbanBoardSummary,
  HermesKanbanGetBoardInput,
  HermesKanbanGetTaskInput,
  HermesKanbanListBoardsResult,
  HermesKanbanTask,
  HermesKanbanTaskResult,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import {
  HERMES_KANBAN_DEFAULT_BOARD,
  countHermesKanbanTasks,
  deriveHermesKanbanStructure,
  findHermesKanbanBoard,
  listHermesKanbanBoards,
  parseHermesKanbanBody,
  readHermesKanbanBoardRows,
  readHermesKanbanComments,
  resolveHermesKanbanHome,
  type HermesKanbanBoardEntry,
  type HermesKanbanBoardRows,
  type HermesKanbanTaskRow,
} from "./hermesKanbanState.ts";
import { isoFromSeconds } from "./hermesRunTranscript.ts";

export class HermesKanbanService extends Context.Service<
  HermesKanbanService,
  {
    /** Every live board with its counts. */
    readonly listBoards: Effect.Effect<HermesKanbanListBoardsResult>;
    /** One board's cards, links, and milestone structure. */
    readonly getBoard: (input: HermesKanbanGetBoardInput) => Effect.Effect<HermesKanbanBoard>;
    /** One card with its body and comments. */
    readonly getTask: (input: HermesKanbanGetTaskInput) => Effect.Effect<HermesKanbanTaskResult>;
  }
>()("t3-hermes/hermes/HermesKanbanService") {}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

function summaryFrom(
  entry: HermesKanbanBoardEntry,
  rows: HermesKanbanBoardRows | null,
): HermesKanbanBoardSummary {
  const counts = countHermesKanbanTasks(rows?.tasks ?? []);
  const lastActivity =
    rows === null
      ? null
      : (rows.lastEventAt ??
        (rows.tasks.length === 0 ? null : Math.max(...rows.tasks.map((t) => t.lastActivityAt))));
  return {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    color: entry.color,
    readable: rows !== null,
    ...counts,
    lastActivityAt: lastActivity === null ? null : isoFromSeconds(lastActivity),
  };
}

function taskFrom(row: HermesKanbanTaskRow): HermesKanbanTask {
  const fields = parseHermesKanbanBody(row.body);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assignee: row.assignee,
    priority: row.priority,
    createdAt: isoFromSeconds(row.createdAt),
    startedAt: row.startedAt === null ? null : isoFromSeconds(row.startedAt),
    completedAt: row.completedAt === null ? null : isoFromSeconds(row.completedAt),
    lastActivityAt: isoFromSeconds(row.lastActivityAt),
    threadId: fields.threadId === null ? null : Option.getOrNull(decodeThreadId(fields.threadId)),
    pullRequestUrl: fields.pullRequestUrl,
    branch: fields.branch,
    commentCount: row.commentCount,
  };
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;

  // Boards live in the root Hermes home, shared by every profile.
  const kanbanHome = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const instance = settings === null ? null : resolveEnabledHermesInstance(settings);
    if (instance === null) return null;
    const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
    return resolveHermesKanbanHome(resolveHermesHome(environment), environment);
  });

  const listBoards: HermesKanbanService["Service"]["listBoards"] = Effect.gen(function* () {
    const home = yield* kanbanHome;
    if (home === null) return { availability: "hermes-off" as const, boards: [] };
    const boards = yield* Effect.sync(() =>
      listHermesKanbanBoards(home).flatMap((entry) => {
        const summary = summaryFrom(entry, readHermesKanbanBoardRows(entry.dbPath));
        // The legacy default board always exists and is usually empty; list it only in use.
        return entry.slug === HERMES_KANBAN_DEFAULT_BOARD && summary.taskCount === 0
          ? []
          : [summary];
      }),
    );
    return { availability: "ready" as const, boards };
  }).pipe(Effect.withSpan("HermesKanbanService.listBoards"));

  const getBoard: HermesKanbanService["Service"]["getBoard"] = Effect.fn(
    "HermesKanbanService.getBoard",
  )(function* (input) {
    const empty = { board: null, tasks: [], links: [], features: [], standaloneIds: [] };
    const home = yield* kanbanHome;
    if (home === null) return { availability: "hermes-off" as const, ...empty };
    const read = yield* Effect.sync(() => {
      const entry = findHermesKanbanBoard(home, input.slug);
      return entry === null ? null : { entry, rows: readHermesKanbanBoardRows(entry.dbPath) };
    });
    if (read === null) return { availability: "ready" as const, ...empty };
    if (read.rows === null) {
      return {
        availability: "unavailable" as const,
        ...empty,
        board: summaryFrom(read.entry, null),
      };
    }
    const structure = deriveHermesKanbanStructure(read.rows.tasks, read.rows.links);
    return {
      availability: "ready" as const,
      board: summaryFrom(read.entry, read.rows),
      tasks: read.rows.tasks.map(taskFrom),
      links: read.rows.links,
      features: structure.features,
      standaloneIds: structure.standaloneIds,
    };
  });

  const getTask: HermesKanbanService["Service"]["getTask"] = Effect.fn(
    "HermesKanbanService.getTask",
  )(function* (input) {
    const empty = { task: null, comments: [] };
    const home = yield* kanbanHome;
    if (home === null) return { availability: "hermes-off" as const, ...empty };
    const read = yield* Effect.sync(() => {
      const entry = findHermesKanbanBoard(home, input.slug);
      if (entry === null) return { rows: undefined, comments: null };
      const rows = readHermesKanbanBoardRows(entry.dbPath);
      return {
        rows,
        comments: rows === null ? null : readHermesKanbanComments(entry.dbPath, input.taskId),
      };
    });
    if (read.rows === undefined) return { availability: "ready" as const, ...empty };
    if (read.rows === null || read.comments === null) {
      return { availability: "unavailable" as const, ...empty };
    }
    const row = read.rows.tasks.find((task) => task.id === input.taskId);
    if (row === undefined) return { availability: "ready" as const, ...empty };
    return {
      availability: "ready" as const,
      task: {
        ...taskFrom(row),
        body: row.body,
        result: row.result,
        parentIds: read.rows.links
          .filter((link) => link.childId === row.id)
          .map((link) => link.parentId),
        childIds: read.rows.links
          .filter((link) => link.parentId === row.id)
          .map((link) => link.childId),
      },
      comments: read.comments.map((comment) => ({
        ...comment,
        createdAt: isoFromSeconds(comment.createdAt),
      })),
    };
  });

  return HermesKanbanService.of({ listBoards, getBoard, getTask });
});

export const layer = Layer.effect(HermesKanbanService, make);
