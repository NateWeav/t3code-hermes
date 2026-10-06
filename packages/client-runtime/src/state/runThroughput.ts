/**
 * Client view of a thread's live output rate. The server measures it from the
 * provider's raw deltas and pushes a sample a few times a second while the
 * model generates; the client only keeps a short history for a sparkline.
 *
 * @module state/runThroughput
 */
import type { OrchestrationV2RunThroughput } from "@t3tools/contracts";

export interface RunThroughputReadout extends OrchestrationV2RunThroughput {
  /** Rates pushed while generating, oldest first, for a sparkline. */
  readonly history: ReadonlyArray<number>;
}

export const RUN_THROUGHPUT_HISTORY_LENGTH = 24;

/** Folds the next server sample into the readout, restarting the history for a new run. */
export function accumulateRunThroughput(
  previous: RunThroughputReadout | null,
  next: OrchestrationV2RunThroughput | null,
): RunThroughputReadout | null {
  if (next === null) return null;
  const history = previous?.runId === next.runId ? previous.history : [];
  if (next.idle || next.tokensPerSecond === null) return { ...next, history };
  return {
    ...next,
    history: [...history, next.tokensPerSecond].slice(-RUN_THROUGHPUT_HISTORY_LENGTH),
  };
}
