import { describe, expect, it } from "vite-plus/test";

import { RunId, type OrchestrationV2RunThroughput } from "@t3tools/contracts";

import { accumulateRunThroughput, RUN_THROUGHPUT_HISTORY_LENGTH } from "./runThroughput.ts";

const run = RunId.make("run-1");

function sample(
  tokensPerSecond: number,
  options: { readonly idle?: boolean; readonly runId?: RunId } = {},
): OrchestrationV2RunThroughput {
  return {
    runId: options.runId ?? run,
    tokensPerSecond,
    idle: options.idle ?? false,
    averageTokensPerSecond: null,
    peakTokensPerSecond: null,
    outputTokens: 0,
  };
}

describe("accumulateRunThroughput", () => {
  it("keeps generating rates for the sparkline but not idle repeats of the last one", () => {
    let readout = accumulateRunThroughput(null, sample(80));
    readout = accumulateRunThroughput(readout, sample(90));
    readout = accumulateRunThroughput(readout, sample(90, { idle: true }));
    expect(readout).toMatchObject({ tokensPerSecond: 90, idle: true, history: [80, 90] });
  });

  it("restarts the history for a new run and clears when the run ends", () => {
    const first = accumulateRunThroughput(null, sample(80));
    const next = accumulateRunThroughput(first, sample(40, { runId: RunId.make("run-2") }));
    expect(next?.history).toEqual([40]);
    expect(accumulateRunThroughput(next, null)).toBeNull();
  });

  it("caps the history", () => {
    let readout = null;
    for (let rate = 0; rate < RUN_THROUGHPUT_HISTORY_LENGTH + 5; rate += 1) {
      readout = accumulateRunThroughput(readout, sample(rate));
    }
    expect(readout?.history).toHaveLength(RUN_THROUGHPUT_HISTORY_LENGTH);
    expect(readout?.history.at(-1)).toBe(RUN_THROUGHPUT_HISTORY_LENGTH + 4);
  });
});
