/**
 * Read-only views of Hermes Kanban boards, read on demand from each board's own `kanban.db`.
 * Nothing here can move, complete, or dispatch a card: Hermes stays the source of truth and T3 Code
 * keeps no copy. The only writes are T3 Code's own per-board preferences (a linked T3 project and
 * an uploaded icon), stored beside the server's state and never in Hermes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** `hermes-off`: no Hermes provider is enabled. `unavailable`: the Kanban home could not be read. */
export const HermesKanbanAvailability = Schema.Literals(["ready", "hermes-off", "unavailable"]);
export type HermesKanbanAvailability = typeof HermesKanbanAvailability.Type;

/** A board's directory name under `kanban/boards/`, or `default` for the legacy root board. */
export const HermesKanbanBoardSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/),
);
export type HermesKanbanBoardSlug = typeof HermesKanbanBoardSlug.Type;

const HermesKanbanTaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** Decoded size cap for an uploaded board icon. Clients downscale to ~128px well below it. */
export const HERMES_KANBAN_BOARD_ICON_MAX_BYTES = 256 * 1024;

export const HermesKanbanBoardIconMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
export type HermesKanbanBoardIconMimeType = typeof HermesKanbanBoardIconMimeType.Type;

/**
 * An uploaded board icon as a base64 `data:` URL. Clients render it only as `<img src>`, never
 * inline, so an SVG's scripts and external loads stay inert. The server checks the URL's media
 * type and decoded size; the length check here only bounds the payload.
 */
export const HermesKanbanBoardIcon = Schema.Struct({
  dataUrl: Schema.String.check(
    Schema.isMaxLength(Math.ceil(HERMES_KANBAN_BOARD_ICON_MAX_BYTES / 3) * 4 + 64),
  ),
  mimeType: HermesKanbanBoardIconMimeType,
});
export type HermesKanbanBoardIcon = typeof HermesKanbanBoardIcon.Type;

export const HermesKanbanBoardSummary = Schema.Struct({
  slug: HermesKanbanBoardSlug,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  /** An emoji, as `hermes kanban boards create --icon` stores it. */
  icon: Schema.NullOr(Schema.String),
  /** A CSS color, usually `#rrggbb`. */
  color: Schema.NullOr(Schema.String),
  /** False when the board's database could not be read; its counts are then zero. */
  readable: Schema.Boolean,
  /** Cards that are not archived. */
  taskCount: NonNegativeInt,
  doneCount: NonNegativeInt,
  runningCount: NonNegativeInt,
  blockedCount: NonNegativeInt,
  /** Cards per Hermes status (`todo`, `ready`, `running`, ...), archived left out. */
  statusCounts: Schema.Record(Schema.String, NonNegativeInt),
  /** The newest task event on the board. */
  lastActivityAt: Schema.NullOr(IsoDateTime),
  /**
   * The T3 project this board is linked to, a T3 Code preference. Unrelated to Hermes's own
   * `project_id`. Defaults to null so an older server's summaries still decode.
   */
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** An uploaded icon, a T3 Code preference that wins over the project icon and the emoji. */
  customIcon: Schema.NullOr(HermesKanbanBoardIcon).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HermesKanbanBoardSummary = typeof HermesKanbanBoardSummary.Type;

export const HermesKanbanTask = Schema.Struct({
  id: HermesKanbanTaskId,
  title: Schema.String,
  /** A Hermes workflow status. Kept open: newer Hermes releases may add statuses. */
  status: TrimmedNonEmptyString,
  assignee: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  /** The card's newest task event, else its newest timestamp. */
  lastActivityAt: IsoDateTime,
  /** From a `T3-Thread: t3-thread://v1/<id>` body line. */
  threadId: Schema.NullOr(ThreadId),
  /** From a `PR: <url>` body line. */
  pullRequestUrl: Schema.NullOr(Schema.String),
  /** From a `Branch: <name>` body line. */
  branch: Schema.NullOr(Schema.String),
  commentCount: NonNegativeInt,
});
export type HermesKanbanTask = typeof HermesKanbanTask.Type;

/** A dependency: the child waits until every parent is done. */
export const HermesKanbanLink = Schema.Struct({
  parentId: HermesKanbanTaskId,
  childId: HermesKanbanTaskId,
});
export type HermesKanbanLink = typeof HermesKanbanLink.Type;

/**
 * A card with milestones: the child of at least one link. Its milestones are its parents, so it
 * finishes once they are all done.
 */
export const HermesKanbanFeature = Schema.Struct({
  taskId: HermesKanbanTaskId,
  /** Oldest first. */
  milestoneIds: ForwardCompatibleArray(HermesKanbanTaskId),
  doneCount: NonNegativeInt,
  totalCount: NonNegativeInt,
});
export type HermesKanbanFeature = typeof HermesKanbanFeature.Type;

export const HermesKanbanListBoardsResult = Schema.Struct({
  availability: HermesKanbanAvailability,
  /** `default` first when it holds cards, then by slug. */
  boards: ForwardCompatibleArray(HermesKanbanBoardSummary),
});
export type HermesKanbanListBoardsResult = typeof HermesKanbanListBoardsResult.Type;

export const HermesKanbanGetBoardInput = Schema.Struct({
  slug: HermesKanbanBoardSlug,
});
export type HermesKanbanGetBoardInput = typeof HermesKanbanGetBoardInput.Type;

export const HermesKanbanBoard = Schema.Struct({
  availability: HermesKanbanAvailability,
  /** Null when no listed board has this slug. */
  board: Schema.NullOr(HermesKanbanBoardSummary),
  /** Oldest first, archived left out. */
  tasks: ForwardCompatibleArray(HermesKanbanTask),
  links: ForwardCompatibleArray(HermesKanbanLink),
  features: ForwardCompatibleArray(HermesKanbanFeature),
  /** Cards that are neither a feature nor one of its milestones, oldest first. */
  standaloneIds: ForwardCompatibleArray(HermesKanbanTaskId),
});
export type HermesKanbanBoard = typeof HermesKanbanBoard.Type;

export const HermesKanbanGetTaskInput = Schema.Struct({
  slug: HermesKanbanBoardSlug,
  taskId: HermesKanbanTaskId,
});
export type HermesKanbanGetTaskInput = typeof HermesKanbanGetTaskInput.Type;

export const HermesKanbanComment = Schema.Struct({
  id: NonNegativeInt,
  author: Schema.String,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type HermesKanbanComment = typeof HermesKanbanComment.Type;

export const HermesKanbanTaskDetail = Schema.Struct({
  ...HermesKanbanTask.fields,
  /** Markdown, `T3-Thread:`/`PR:`/`Branch:` lines included. */
  body: Schema.NullOr(Schema.String),
  /** What the worker or the person completing the card wrote. */
  result: Schema.NullOr(Schema.String),
  /** Milestones this card waits on. */
  parentIds: ForwardCompatibleArray(HermesKanbanTaskId),
  /** Cards that wait on this one. */
  childIds: ForwardCompatibleArray(HermesKanbanTaskId),
});
export type HermesKanbanTaskDetail = typeof HermesKanbanTaskDetail.Type;

export const HermesKanbanTaskResult = Schema.Struct({
  availability: HermesKanbanAvailability,
  /** Null when the board or the card is missing, or the card is archived. */
  task: Schema.NullOr(HermesKanbanTaskDetail),
  /** Oldest first. */
  comments: ForwardCompatibleArray(HermesKanbanComment),
});
export type HermesKanbanTaskResult = typeof HermesKanbanTaskResult.Type;

/** Link a board to a T3 project, or unlink it with null. */
export const HermesKanbanSetBoardProjectInput = Schema.Struct({
  slug: HermesKanbanBoardSlug,
  projectId: Schema.NullOr(ProjectId),
});
export type HermesKanbanSetBoardProjectInput = typeof HermesKanbanSetBoardProjectInput.Type;

/** Upload a board icon, or remove it with null. */
export const HermesKanbanSetBoardIconInput = Schema.Struct({
  slug: HermesKanbanBoardSlug,
  icon: Schema.NullOr(HermesKanbanBoardIcon),
});
export type HermesKanbanSetBoardIconInput = typeof HermesKanbanSetBoardIconInput.Type;

/** A board's T3 Code preferences after a change. */
export const HermesKanbanBoardPreferences = Schema.Struct({
  slug: HermesKanbanBoardSlug,
  projectId: Schema.NullOr(ProjectId),
  customIcon: Schema.NullOr(HermesKanbanBoardIcon),
});
export type HermesKanbanBoardPreferences = typeof HermesKanbanBoardPreferences.Type;

export class HermesKanbanError extends Schema.TaggedError<HermesKanbanError>()(
  "HermesKanbanError",
  {
    reason: Schema.Literals(["providerDisabled", "unknownBoard", "invalidIcon", "writeFailed"]),
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hermes board request failed (${this.reason}): ${this.detail}`;
  }
}
