import { assert, describe, it } from "@effect/vitest";

import { parseReplayReport } from "./collect.ts";
import { computeProviderMetrics, type ItemRow, type RunRow } from "./metrics.ts";
import type { ParityScenario } from "./scenarios.ts";
import {
  buildScorecard,
  capabilityRank,
  compareLatency,
  diffCapabilities,
  latencyScore,
  scoreScenario,
  stats,
  type Inventory,
  type LiveReport,
  type ProviderMetrics,
} from "./score.ts";

const variant = (driver: string, assertionId: number, transcriptExists = true) => ({
  driver,
  model: "m",
  assertionId,
  assertionName: `assert${assertionId}`,
  transcriptExists,
});

const inventory: Inventory = {
  scenarios: [
    {
      name: "shared",
      variants: [variant("codex", 1), variant("claudeAgent", 2), variant("hermes", 1)],
    },
    { name: "own", variants: [variant("codex", 1), variant("hermes", 3)] },
    { name: "broken", variants: [variant("codex", 1), variant("hermes", 1)] },
    { name: "unrecorded", variants: [variant("codex", 1)] },
    { name: "unwritten", variants: [variant("hermes", 1, false), variant("codex", 1)] },
    { name: "claude_only_tool", variants: [variant("claudeAgent", 4)] },
    { name: "hermes_only_tool", variants: [variant("hermes", 4)] },
    { name: "orphan", variants: [variant("cursor", 1), variant("hermes", 1)] },
  ],
  capabilities: {},
};

const replay = new Map([
  ["shared/hermes", { passed: true }],
  ["own/hermes", { passed: true }],
  ["broken/hermes", { passed: false, failure: "AssertionError: runs differ\nstack" }],
  ["hermes_only_tool/hermes", { passed: true }],
]);

const liveReport = (scenario: string, passed: boolean): LiveReport => ({
  driver: "hermes",
  scenario,
  passed,
  assertion: passed ? "codex" : null,
  failure: passed ? null : "codex: no",
  sessionOpenMs: [1000],
  turns: [{ firstActivityMs: 10, firstTextMs: 20, terminalMs: 30 }],
  interruptMs: [],
  stuckItems: 0,
});

describe("scoreScenario", () => {
  const scenario = (name: string, hermes: ParityScenario["hermes"]): ParityScenario => ({
    name,
    facet: "turns",
    hermes,
  });
  const applicable = { kind: "applicable" } as const;

  it.each([
    ["shared", applicable, "parity", 1],
    ["own", applicable, "divergent", 0.5],
    ["broken", applicable, "failing", 0],
    ["unrecorded", applicable, "missing", 0],
    ["unwritten", applicable, "missing", 0],
    ["claude_only_tool", { kind: "twin", reason: "r" }, "twin-missing", 0],
    ["claude_only_tool", { kind: "twin", reason: "r", twin: "hermes_only_tool" }, "parity", 1],
    ["orphan", applicable, "no-reference", null],
    ["shared", { kind: "na", reason: "r" }, "na", null],
  ] as const)("%s (%o) scores %s", (name, hermes, status, points) => {
    const score = scoreScenario({ scenario: scenario(name, hermes), inventory, replay, live: [] });
    assert.equal(score.status, status);
    assert.equal(score.points, points);
  });

  it("carries the replay failure and live samples", () => {
    const score = scoreScenario({
      scenario: scenario("broken", applicable),
      inventory,
      replay,
      live: [liveReport("broken", true), liveReport("broken", false)],
    });
    assert.include(score.failure ?? "", "runs differ");
    assert.deepEqual(score.live, {
      samples: 2,
      passed: 1,
      assertion: "codex",
      failure: "codex: no",
    });
  });
});

describe("capabilities", () => {
  it("ranks flags by what is better for the user", () => {
    assert.equal(capabilityRank("turns.supportsInterrupt", true), 1);
    assert.equal(capabilityRank("approvals.approvalCallbacksAreLiveOnly", true), 0);
    assert.equal(capabilityRank("turns.activeSteeringInterruptsTools", undefined), 1);
    assert.isAbove(
      capabilityRank("identity.nativeItemIds", "strong")!,
      capabilityRank("identity.nativeItemIds", "weak")!,
    );
    assert.equal(capabilityRank("runtimePolicy.enforcement", "native"), 1);
    assert.equal(capabilityRank("context.maxRecommendedHandoffChars", null), 1);
  });

  it("lists gaps against each reference and skips quirks of steering Hermes cannot do", () => {
    const { behind, ahead } = diffCapabilities({
      hermes: {
        turns: { supportsActiveSteering: false, supportsInterrupt: true },
        streaming: { streamsToolOutput: true },
      },
      claudeAgent: {
        turns: {
          supportsActiveSteering: true,
          activeSteeringInterruptsTools: true,
          supportsInterrupt: true,
        },
        streaming: { streamsToolOutput: false },
      },
      codex: {
        turns: { supportsActiveSteering: true, supportsInterrupt: true },
        streaming: { streamsToolOutput: true },
      },
    });
    assert.deepEqual(
      behind.map((gap) => `${gap.vs}:${gap.path}`),
      ["claudeAgent:turns.supportsActiveSteering", "codex:turns.supportsActiveSteering"],
    );
    assert.deepEqual(
      ahead.map((gap) => `${gap.vs}:${gap.path}`),
      ["claudeAgent:streaming.streamsToolOutput"],
    );
  });
});

describe("computeProviderMetrics", () => {
  const run = (overrides: Partial<RunRow> & Pick<RunRow, "runId" | "ordinal">): RunRow => ({
    threadId: "t1",
    provider: "hermes",
    status: "completed",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:02.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    ...overrides,
  });
  const item = (runId: string, type: string, at: string, status = "completed"): ItemRow => ({
    runId,
    type,
    status,
    startedAt: at,
  });

  it("splits cold and warm starts and leaves out runs queued behind another", () => {
    const metrics = computeProviderMetrics(
      [
        run({ runId: "r1", ordinal: 1 }),
        // Sent after r1 finished: a warm start.
        run({
          runId: "r2",
          ordinal: 2,
          requestedAt: "2026-01-01T00:00:20.000Z",
          startedAt: "2026-01-01T00:00:20.500Z",
          completedAt: "2026-01-01T00:00:30.000Z",
        }),
        // Sent while r2 ran: its wait is the queue, not the provider.
        run({
          runId: "r3",
          ordinal: 3,
          status: "failed",
          requestedAt: "2026-01-01T00:00:25.000Z",
          startedAt: "2026-01-01T00:00:30.000Z",
          completedAt: "2026-01-01T00:00:31.000Z",
        }),
      ],
      [
        item("r1", "command_execution", "2026-01-01T00:00:03.000Z"),
        item("r1", "assistant_message", "2026-01-01T00:00:05.000Z"),
        item("r1", "dynamic_tool", "2026-01-01T00:00:04.000Z", "running"),
        item("r2", "reasoning", "2026-01-01T00:00:21.000Z"),
        item("r2", "assistant_message", "2026-01-01T00:00:22.000Z"),
      ],
    );
    assert.deepEqual(metrics.coldStartMs, stats([2000]));
    assert.deepEqual(metrics.warmStartMs, stats([500]));
    assert.deepEqual(metrics.coldFirstActivityMs, stats([3000]));
    assert.deepEqual(metrics.warmFirstTextMs, stats([2000]));
    assert.equal(metrics.failed, 1);
    assert.equal(metrics.stuckItems, 1);
    assert.equal(metrics.typedToolShare, 0.5);
    assert.equal(metrics.reasoningPerAssistantMessage, 0.5);
  });
});

describe("latency", () => {
  const metrics = (p50: number): ProviderMetrics => {
    const one = { n: 1, p50, p90: p50 };
    return {
      runs: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      coldStartMs: one,
      warmStartMs: one,
      coldFirstActivityMs: one,
      warmFirstActivityMs: one,
      coldFirstTextMs: one,
      warmFirstTextMs: one,
      runMs: one,
      reasoningPerAssistantMessage: null,
      typedToolShare: null,
      errorItemsPerRun: null,
      stuckItems: 0,
    };
  };

  it("scores Hermes against the reference, capped at as fast", () => {
    assert.equal(latencyScore(compareLatency(metrics(4000), metrics(1000))), 25);
    assert.equal(latencyScore(compareLatency(metrics(500), metrics(1000))), 100);
    assert.isNull(latencyScore(compareLatency(undefined, metrics(1000))));
  });
});

describe("parseReplayReport", () => {
  it("reads scenario and driver from the replay test titles", () => {
    const results = parseReplayReport({
      testResults: [
        {
          assertionResults: [
            {
              title: "runs simple/hermes through OrchestratorV2 using deterministic replay",
              status: "passed",
            },
            {
              title:
                "runs thread_rollback/claudeAgent through OrchestratorV2 using deterministic replay",
              status: "failed",
              failureMessages: ["boom"],
            },
            { title: "something else", status: "passed" },
          ],
        },
      ],
    });
    assert.deepEqual(
      [...results.entries()],
      [
        ["simple/hermes", { passed: true }],
        ["thread_rollback/claudeAgent", { passed: false, failure: "boom" }],
      ],
    );
  });
});

describe("buildScorecard", () => {
  it("puts a live pass waiting to be recorded ahead of fixes worth the same", () => {
    const card = buildScorecard({
      manifest: [
        { name: "shared", facet: "turns", hermes: { kind: "applicable" } },
        { name: "unrecorded", facet: "turns", hermes: { kind: "applicable" } },
        { name: "broken", facet: "turns", hermes: { kind: "applicable" } },
        { name: "claude_only_tool", facet: "turns", hermes: { kind: "applicable" } },
      ],
      inventory,
      replay,
      live: [liveReport("unrecorded", true)],
      stack: null,
      field: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // One live sample says nothing about reliability, so only turns (1/4) is scored.
    assert.deepEqual(card.headline, { parity: 25, facets: ["turns"] });
    assert.deepEqual(card.claudeParity, { passed: 1, covered: 2 });
    assert.deepEqual(
      card.nextSteps.map((step) => step.scenario),
      ["unrecorded", "broken", "claude_only_tool"],
    );
  });
});
