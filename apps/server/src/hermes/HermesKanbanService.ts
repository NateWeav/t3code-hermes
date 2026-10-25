/**
 * Read-only views of Hermes Kanban boards, read on demand from each board's `kanban.db`; reads
 * never fail (see `availability`, `readable`). The only writes are T3 Code's own board
 * preferences (linked project, uploaded icon) in a JSON file under the state dir, never Hermes's.
 */
import type {
  HermesKanbanBoard,
  HermesKanbanBoardPreferences,
  HermesKanbanBoardSummary,
  HermesKanbanGetBoardInput,
  HermesKanbanGetTaskInput,
  HermesKanbanListBoardsResult,
  HermesKanbanSetBoardIconInput,
  HermesKanbanSetBoardProjectInput,
  HermesKanbanTask,
  HermesKanbanTaskResult,
} from "@t3tools/contracts";
import { HermesKanbanError, ThreadId } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
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
import {
  HERMES_KANBAN_PREFERENCES_FILENAME,
  hermesKanbanIconProblem,
  parseHermesKanbanPreferences,
  serializeHermesKanbanPreferences,
  withHermesKanbanPreference,
  type HermesKanbanBoardPreference,
  type HermesKanbanPreferenceMap,
} from "./hermesKanbanPreferences.ts";
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
    /** Link a listed board to a T3 project, or unlink it. */
    readonly setBoardProject: (
      input: HermesKanbanSetBoardProjectInput,
    ) => Effect.Effect<HermesKanbanBoardPreferences, HermesKanbanError>;
    /** Store or remove a listed board's uploaded icon. */
    readonly setBoardIcon: (
      input: HermesKanbanSetBoardIconInput,
    ) => Effect.Effect<HermesKanbanBoardPreferences, HermesKanbanError>;
  }
>()("t3-hermes/hermes/HermesKanbanService") {}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

function summaryFrom(
  entry: HermesKanbanBoardEntry,
  rows: HermesKanbanBoardRows | null,
  preference: HermesKanbanBoardPreference | undefined,
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
    projectId: preference?.projectId ?? null,
    customIcon: preference?.icon ?? null,
  };
}

function preferencesFor(
  slug: string,
  preference: HermesKanbanBoardPreference | undefined,
): HermesKanbanBoardPreferences {
  return { slug, projectId: preference?.projectId ?? null, customIcon: preference?.icon ?? null };
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
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const preferencesPath = path.join(config.stateDir, HERMES_KANBAN_PREFERENCES_FILENAME);
  const preferencesRef = yield* Ref.make<HermesKanbanPreferenceMap>(new Map());
  const preferencesMutex = yield* Semaphore.make(1);

  // A missing or unreadable file means no preferences: every board renders as Hermes has it.
  yield* Effect.gen(function* () {
    const raw = yield* fs.readFileString(preferencesPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return;
    yield* Ref.set(preferencesRef, parseHermesKanbanPreferences(raw));
  });

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
    const preferences = yield* Ref.get(preferencesRef);
    const boards = yield* Effect.sync(() =>
      listHermesKanbanBoards(home).flatMap((entry) => {
        const summary = summaryFrom(
          entry,
          readHermesKanbanBoardRows(entry.dbPath),
          preferences.get(entry.slug),
        );
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
    const preference = (yield* Ref.get(preferencesRef)).get(read.entry.slug);
    if (read.rows === null) {
      return {
        availability: "unavailable" as const,
        ...empty,
        board: summaryFrom(read.entry, null, preference),
      };
    }
    const structure = deriveHermesKanbanStructure(read.rows.tasks, read.rows.links);
    return {
      availability: "ready" as const,
      board: summaryFrom(read.entry, read.rows, preference),
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

  /** Preferences attach only to boards Hermes lists, so a typo never leaves an orphan entry. */
  const requireBoard = Effect.fn("HermesKanbanService.requireBoard")(function* (slug: string) {
    const home = yield* kanbanHome;
    if (home === null) {
      return yield* new HermesKanbanError({
        reason: "providerDisabled",
        detail: "Hermes is not enabled in this environment.",
      });
    }
    const entry = yield* Effect.sync(() => findHermesKanbanBoard(home, slug));
    if (entry === null) {
      return yield* new HermesKanbanError({
        reason: "unknownBoard",
        detail: "Hermes has no board with that slug.",
      });
    }
    return entry.slug;
  });

  const updatePreference = (
    slug: string,
    change: Parameters<typeof withHermesKanbanPreference>[2],
  ): Effect.Effect<HermesKanbanBoardPreferences, HermesKanbanError> =>
    preferencesMutex.withPermits(1)(
      Effect.gen(function* () {
        const next = withHermesKanbanPreference(yield* Ref.get(preferencesRef), slug, change);
        yield* writeFileStringAtomically({
          filePath: preferencesPath,
          contents: serializeHermesKanbanPreferences(next),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new HermesKanbanError({
                reason: "writeFailed",
                detail: "Could not save the board's settings.",
                cause,
              }),
          ),
        );
        yield* Ref.set(preferencesRef, next);
        return preferencesFor(slug, next.get(slug));
      }),
    );

  const setBoardProject: HermesKanbanService["Service"]["setBoardProject"] = Effect.fn(
    "HermesKanbanService.setBoardProject",
  )(function* (input) {
    const slug = yield* requireBoard(input.slug);
    // The project is not checked against the project list: a link to a project that is later
    // removed must keep working as "no project", so clients already treat a missing one as unset.
    return yield* updatePreference(slug, { projectId: input.projectId });
  });

  const setBoardIcon: HermesKanbanService["Service"]["setBoardIcon"] = Effect.fn(
    "HermesKanbanService.setBoardIcon",
  )(function* (input) {
    const slug = yield* requireBoard(input.slug);
    if (input.icon !== null) {
      const problem = hermesKanbanIconProblem(input.icon);
      if (problem !== null) {
        return yield* new HermesKanbanError({ reason: "invalidIcon", detail: problem });
      }
    }
    return yield* updatePreference(slug, { icon: input.icon });
  });

  return HermesKanbanService.of({
    listBoards,
    getBoard,
    getTask,
    setBoardProject,
    setBoardIcon,
  });
});

export const layer = Layer.effect(HermesKanbanService, make);
