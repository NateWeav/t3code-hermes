/**
 * Per-provider run metrics from a T3 `statev2.sqlite`, opened read-only. The same numbers come
 * from the developer's real history (field) and from the stack suite's own server (stack).
 */
import * as NodeSqlite from "node:sqlite";

import { stats, type ProviderMetrics } from "./score.ts";

export interface RunRow {
  readonly runId: string;
  readonly threadId: string;
  readonly provider: string;
  readonly ordinal: number;
  readonly status: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ItemRow {
  readonly runId: string;
  readonly type: string;
  readonly status: string;
  readonly startedAt: string | null;
}

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE_ITEM = new Set(["pending", "running", "waiting"]);
const TYPED_TOOLS = new Set(["command_execution", "file_change", "web_search", "file_search"]);
const ALL_TOOLS = new Set([...TYPED_TOOLS, "dynamic_tool"]);
/** Rows that show the agent working, as opposed to T3's own bookkeeping. */
const AGENT_ROWS = new Set([...ALL_TOOLS, "assistant_message", "reasoning", "subagent", "plan"]);

const ms = (from: string | null, to: string | null) =>
  from === null || to === null ? null : Date.parse(to) - Date.parse(from);

/** Pure: the metrics for one provider's runs and their turn items. */
export function computeProviderMetrics(
  runs: ReadonlyArray<RunRow>,
  items: ReadonlyArray<ItemRow>,
): ProviderMetrics {
  const itemsByRun = new Map<string, Array<ItemRow>>();
  for (const item of items) {
    const list = itemsByRun.get(item.runId) ?? [];
    list.push(item);
    itemsByRun.set(item.runId, list);
  }
  const byThread = new Map<string, Array<RunRow>>();
  for (const run of runs) {
    const list = byThread.get(run.threadId) ?? [];
    list.push(run);
    byThread.set(run.threadId, list);
  }
  const coldStart: Array<number> = [];
  const warmStart: Array<number> = [];
  const coldFirstActivity: Array<number> = [];
  const warmFirstActivity: Array<number> = [];
  const coldFirstText: Array<number> = [];
  const warmFirstText: Array<number> = [];
  const runMs: Array<number> = [];
  const firstStart = (runId: string, include: (item: ItemRow) => boolean) =>
    (itemsByRun.get(runId) ?? [])
      .filter((item) => include(item) && item.startedAt !== null)
      .map((item) => Date.parse(item.startedAt!))
      .sort((a, b) => a - b)[0];
  for (const threadRuns of byThread.values()) {
    const ordered = [...threadRuns].sort((a, b) => a.ordinal - b.ordinal);
    ordered.forEach((run, index) => {
      if (run.startedAt === null) return;
      const previous = ordered[index - 1];
      // A run queued behind the previous one waited on that run, not on the provider.
      if (previous !== undefined) {
        const previousEnd = previous.completedAt === null ? null : Date.parse(previous.completedAt);
        if (previousEnd === null || previousEnd > Date.parse(run.requestedAt)) return;
      }
      const cold = run.ordinal === 1;
      const start = ms(run.requestedAt, run.startedAt);
      if (start !== null) (cold ? coldStart : warmStart).push(start);
      const requested = Date.parse(run.requestedAt);
      const firstActivity = firstStart(run.runId, (item) => AGENT_ROWS.has(item.type));
      if (firstActivity !== undefined) {
        (cold ? coldFirstActivity : warmFirstActivity).push(firstActivity - requested);
      }
      const firstText = firstStart(run.runId, (item) => item.type === "assistant_message");
      if (firstText !== undefined) {
        (cold ? coldFirstText : warmFirstText).push(firstText - requested);
      }
      if (run.status === "completed") {
        const duration = ms(run.startedAt, run.completedAt);
        if (duration !== null) runMs.push(duration);
      }
    });
  }
  const runIds = new Set(runs.map((run) => run.runId));
  const terminal = new Set(
    runs.filter((run) => TERMINAL_RUN.has(run.status)).map((run) => run.runId),
  );
  const own = items.filter((item) => runIds.has(item.runId));
  const count = (type: string) => own.filter((item) => item.type === type).length;
  const tools = own.filter((item) => ALL_TOOLS.has(item.type));
  const replies = count("assistant_message");
  const status = (value: string) => runs.filter((run) => run.status === value).length;
  return {
    runs: runs.length,
    completed: status("completed"),
    failed: status("failed"),
    cancelled: status("cancelled"),
    interrupted: status("interrupted"),
    coldStartMs: stats(coldStart),
    warmStartMs: stats(warmStart),
    coldFirstActivityMs: stats(coldFirstActivity),
    warmFirstActivityMs: stats(warmFirstActivity),
    coldFirstTextMs: stats(coldFirstText),
    warmFirstTextMs: stats(warmFirstText),
    runMs: stats(runMs),
    reasoningPerAssistantMessage: replies === 0 ? null : count("reasoning") / replies,
    typedToolShare:
      tools.length === 0
        ? null
        : tools.filter((item) => TYPED_TOOLS.has(item.type)).length / tools.length,
    errorItemsPerRun: runs.length === 0 ? null : count("error") / runs.length,
    stuckItems: own.filter((item) => terminal.has(item.runId) && ACTIVE_ITEM.has(item.status))
      .length,
  };
}

/** Reads runs since `sinceIso` and computes metrics per provider driver. */
export function readDatabaseMetrics(input: {
  readonly databasePath: string;
  readonly sinceIso: string;
  readonly providers: ReadonlyArray<string>;
}): Record<string, ProviderMetrics> {
  // Read-only: this may be the developer's live database.
  const db = new NodeSqlite.DatabaseSync(input.databasePath, { readOnly: true });
  try {
    const runs = db
      .prepare(
        `SELECT run_id AS runId, thread_id AS threadId, provider, ordinal, status,
                requested_at AS requestedAt,
                json_extract(payload_json, '$.startedAt') AS startedAt,
                completed_at AS completedAt
           FROM orchestration_v2_projection_runs
          WHERE requested_at >= ?`,
      )
      .all(input.sinceIso) as unknown as Array<RunRow>;
    const items = db
      .prepare(
        `SELECT t.run_id AS runId, t.type, t.status,
                json_extract(t.payload_json, '$.startedAt') AS startedAt
           FROM orchestration_v2_projection_turn_items t
           JOIN orchestration_v2_projection_runs r ON r.run_id = t.run_id
          WHERE r.requested_at >= ?
            -- T3's own workspace setup row, not the agent's work.
            AND json_extract(t.payload_json, '$.id') NOT LIKE '%native-item:workspace-preparation%'`,
      )
      .all(input.sinceIso) as unknown as Array<ItemRow>;
    return Object.fromEntries(
      input.providers.map((provider) => {
        const mine = runs.filter((run) => run.provider === provider);
        const ids = new Set(mine.map((run) => run.runId));
        return [
          provider,
          computeProviderMetrics(
            mine,
            items.filter((item) => ids.has(item.runId)),
          ),
        ];
      }),
    );
  } finally {
    db.close();
  }
}
