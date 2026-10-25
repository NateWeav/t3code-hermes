// @effect-diagnostics globalDate:off -- Display-only relative ages for board and card rows.
/**
 * Presentation for the read-only Hermes Kanban surface: board order, the column model, milestone
 * progress, and labels. No atoms; clients query `hermesKanbanListBoards`/`GetBoard`/`GetTask`.
 */
import type {
  HermesKanbanAvailability,
  HermesKanbanBoard,
  HermesKanbanBoardSummary,
  HermesKanbanTask,
} from "@t3tools/contracts";

/** One board column: the Hermes statuses it gathers, in display order. */
export interface HermesKanbanColumn {
  readonly id: string;
  readonly label: string;
  readonly statuses: readonly string[];
}

/**
 * Hermes's eight workflow statuses folded into four columns. Data rather than code, so a later
 * change can let the user edit it per board.
 */
export const HERMES_KANBAN_DEFAULT_COLUMNS: readonly HermesKanbanColumn[] = [
  { id: "todo", label: "To do", statuses: ["triage", "todo", "scheduled", "ready"] },
  { id: "in-progress", label: "In progress", statuses: ["running", "review"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "done", label: "Done", statuses: ["done"] },
];

const OTHER_COLUMN_ID = "other";

/**
 * The board's cards per column, in task order. A status no column claims (a newer Hermes's) lands
 * in a trailing "Other" column, shown only while it has cards, so no card goes missing.
 */
export function hermesKanbanColumnCards(
  tasks: readonly HermesKanbanTask[],
  columns: readonly HermesKanbanColumn[] = HERMES_KANBAN_DEFAULT_COLUMNS,
): ReadonlyArray<{ readonly column: HermesKanbanColumn; readonly tasks: HermesKanbanTask[] }> {
  const buckets = columns.map((column) => ({ column, tasks: [] as HermesKanbanTask[] }));
  const other: HermesKanbanTask[] = [];
  for (const task of tasks) {
    const bucket = buckets.find((entry) => entry.column.statuses.includes(task.status));
    (bucket?.tasks ?? other).push(task);
  }
  if (other.length === 0) return buckets;
  const statuses = [...new Set(other.map((task) => task.status))];
  return [...buckets, { column: { id: OTHER_COLUMN_ID, label: "Other", statuses }, tasks: other }];
}

function activityMillis(iso: string | null): number {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** Boards with blocked cards first, then the most recently touched. */
export function sortHermesKanbanBoards(
  boards: readonly HermesKanbanBoardSummary[],
): HermesKanbanBoardSummary[] {
  return boards.toSorted(
    (a, b) =>
      Number(b.blockedCount > 0) - Number(a.blockedCount > 0) ||
      activityMillis(b.lastActivityAt) - activityMillis(a.lastActivityAt) ||
      a.slug.localeCompare(b.slug),
  );
}

/** Whole percent, 0 for an empty total. */
export function hermesKanbanProgressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((Math.min(done, total) / total) * 100);
}

export type HermesKanbanStatusTone = "done" | "active" | "blocked" | "waiting";

export function hermesKanbanStatusTone(status: string): HermesKanbanStatusTone {
  switch (status) {
    case "done":
      return "done";
    case "running":
    case "review":
      return "active";
    case "blocked":
      return "blocked";
    default:
      return "waiting";
  }
}

export function hermesKanbanStatusLabel(status: string): string {
  return status === "todo"
    ? "To do"
    : status.replace(/[_-]+/g, " ").replace(/^\w/, (first) => first.toUpperCase());
}

export function formatHermesKanbanAge(iso: string | null, now = Date.now()): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface HermesKanbanFeatureView {
  readonly task: HermesKanbanTask;
  readonly milestones: readonly HermesKanbanTask[];
  readonly doneCount: number;
  readonly totalCount: number;
}

/** The milestones list: each feature with its milestone cards, then the standalone cards. */
export function hermesKanbanMilestoneView(
  board: Pick<HermesKanbanBoard, "tasks" | "features" | "standaloneIds">,
): {
  readonly features: readonly HermesKanbanFeatureView[];
  readonly standalone: readonly HermesKanbanTask[];
} {
  const byId = new Map(board.tasks.map((task) => [task.id, task]));
  const pick = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const task = byId.get(id);
      return task === undefined ? [] : [task];
    });
  return {
    features: board.features.flatMap((feature) => {
      const task = byId.get(feature.taskId);
      return task === undefined
        ? []
        : [
            {
              task,
              milestones: pick(feature.milestoneIds),
              doneCount: feature.doneCount,
              totalCount: feature.totalCount,
            },
          ];
    }),
    standalone: pick(board.standaloneIds),
  };
}

export function describeHermesKanbanAvailability(
  availability: HermesKanbanAvailability,
): { readonly title: string; readonly detail: string } | null {
  switch (availability) {
    case "ready":
      return null;
    case "hermes-off":
      return {
        title: "Hermes is off",
        detail: "Turn on the Hermes provider in Settings to see its Kanban boards.",
      };
    case "unavailable":
      return {
        title: "Board unavailable",
        detail: "This environment could not read the board's database. Try refreshing.",
      };
  }
}
