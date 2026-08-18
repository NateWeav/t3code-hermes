/**
 * Everything the Memory tab says, minus the widgets that say it.
 *
 * The two clients render a Hindsight memory very differently — rows in a web
 * list, cells in a native list — but the words are the same, and the words are
 * the part that has to stay true: which filter means what, why the tab is
 * empty, and what a failed write should tell you. Keeping the copy and the
 * small formatters here is what stops web and mobile from drifting into two
 * different explanations of the same service.
 *
 * @module state/hindsight
 */
import {
  HINDSIGHT_TARGET_API_VERSION,
  type HindsightBankStats,
  type HindsightPathway,
  type HindsightPathwayFilter,
  type HindsightStatus,
} from "@t3tools/contracts";
import { DateTime, Option } from "effect";

/** Prompt used by "Reflect now" when the user has not typed a query. */
export const HINDSIGHT_DEFAULT_REFLECT_QUERY =
  "Summarise what you know, and what you are least sure about.";

export interface HindsightPathwayFilterOption {
  readonly value: HindsightPathwayFilter;
  readonly label: string;
}

export const HINDSIGHT_PATHWAY_FILTERS: ReadonlyArray<HindsightPathwayFilterOption> = [
  { value: "all", label: "All" },
  { value: "world", label: "World" },
  { value: "experience", label: "Experiences" },
  { value: "mentalModel", label: "Mental models" },
];

export const HINDSIGHT_PATHWAY_LABELS: Record<HindsightPathway, string> = {
  world: "World",
  experience: "Experience",
  observation: "Observation",
  mentalModel: "Mental model",
};

/** Coarse buckets on purpose: an exact age is noise on a memory list. */
export function formatHindsightMemoryAge(value: string | null): string | null {
  if (value === null) return null;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return null;
  const elapsed =
    DateTime.toEpochMillis(DateTime.nowUnsafe()) - DateTime.toEpochMillis(parsed.value);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return DateTime.toDate(parsed.value).toLocaleDateString();
}

/** Shown in place of the counts until the first read lands. Never zeroes. */
export const HINDSIGHT_STATS_PENDING_LABEL = "Counting memories…";

export interface HindsightStatsSummary {
  /** The size of the bank, in reading order. Joined with a separator by the UI. */
  readonly counts: ReadonlyArray<string>;
  /** The pathway split, using the same labels as the list's chips. */
  readonly breakdown: ReadonlyArray<string>;
  /** Background work worth mentioning. Empty when nothing is queued or failed. */
  readonly operations: ReadonlyArray<string>;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * The stats strip's words.
 *
 * Pending and failed operations are omitted at zero on purpose: they are the
 * only two numbers here that mean "something needs attention", and a permanent
 * "0 failed" trains people to stop reading the strip.
 */
export function describeHindsightStats(stats: HindsightBankStats): HindsightStatsSummary {
  const consolidated = formatHindsightMemoryAge(stats.lastConsolidatedAt);
  return {
    counts: [
      countLabel(stats.nodes, "memory", "memories"),
      countLabel(stats.links, "link", "links"),
      countLabel(stats.documents, "document", "documents"),
      ...(consolidated === null ? [] : [`consolidated ${consolidated}`]),
    ],
    breakdown: stats.nodesByPathway.map(
      (entry) => `${HINDSIGHT_PATHWAY_LABELS[entry.pathway]} ${entry.count.toLocaleString()}`,
    ),
    operations: [
      ...(stats.pendingOperations > 0
        ? [`${stats.pendingOperations.toLocaleString()} pending`]
        : []),
      ...(stats.failedOperations > 0 ? [`${stats.failedOperations.toLocaleString()} failed`] : []),
    ],
  };
}

export interface HindsightUnavailableState {
  readonly title: string;
  readonly description: string;
  /** Whether asking again could plausibly change the answer. */
  readonly retryable: boolean;
}

/**
 * Copy for a Hindsight that cannot answer, or `null` when it can.
 *
 * The four cases stay distinct all the way to the UI because each has a
 * different next action: write a settings block, start a process, upgrade one
 * of the two sides, or fix the specific request that just failed.
 */
export function describeHindsightUnavailable(
  status: HindsightStatus | null,
): HindsightUnavailableState | null {
  switch (status?.availability) {
    case "notConfigured":
      return {
        title: "Memory is not set up",
        description:
          "Point this environment at a Hindsight service to browse what the agent remembers. Add an integrations.hindsight block to this environment's settings file and restart the server.",
        retryable: false,
      };
    case "offline":
      return {
        title: "Hindsight is not answering",
        description: status.detail ?? "Hindsight is configured but not reachable on this host.",
        retryable: true,
      };
    case "incompatible":
      return {
        title: "Hindsight is a version T3 Code does not understand",
        description:
          status.detail ?? `T3 Code targets Hindsight API ${HINDSIGHT_TARGET_API_VERSION}.`,
        retryable: true,
      };
    case "requestFailed":
      return {
        title: "Memory could not be read",
        description: status.detail ?? "Hindsight did not answer the read.",
        retryable: true,
      };
    default:
      return null;
  }
}

export interface HindsightEmptyListState {
  readonly title: string;
  readonly description: string;
}

/** Why the list is empty: nothing matched, or nothing is there at all. */
export function describeHindsightEmptyList(submittedQuery: string): HindsightEmptyListState {
  return submittedQuery.length > 0
    ? {
        title: "Nothing recalled",
        description: "Hindsight found no memories matching that.",
      }
    : {
        title: "This bank is empty",
        description:
          "Nothing has been remembered here yet. Retain a note below, or let the agent write its own.",
      };
}

/** What a saved note actually produced — Hindsight splits one note into facts. */
export function describeHindsightRetainResult(itemsCount: number): string {
  return itemsCount === 1
    ? "Hindsight extracted 1 memory from it."
    : `Hindsight extracted ${itemsCount} memories from it.`;
}
