// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Recorder reports are wall-clock by design.
/**
 * Wall-clock timings for a live recorder run, read from adapter events so every
 * provider is measured the same way. Recorders pass `--report <file>`; the
 * provider-parity eval aggregates the reports (evals/provider-parity).
 */
import * as NodeFS from "node:fs";

import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  OrchestratorReplayFixture,
  ProviderOrchestratorReplayVariant,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import type { OrchestratorV2ScenarioResult } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";

export interface ParityLiveTurn {
  /** Each is milliseconds after `startTurn` was called; null when it never happened. */
  readonly firstActivityMs: number | null;
  readonly firstTextMs: number | null;
  readonly terminalMs: number | null;
  readonly status: string | null;
}

export interface ParityLiveReport {
  readonly kind: "t3-parity-live";
  readonly version: 1;
  readonly driver: string;
  readonly scenario: string;
  readonly model: string;
  readonly passed: boolean;
  /** Whose fixture assertion passed: the driver's own, or a reference provider's. */
  readonly assertion: string | null;
  readonly failure: string | null;
  readonly startedAt: string;
  readonly wallMs: number;
  readonly sessionOpenMs: ReadonlyArray<number>;
  readonly turns: ReadonlyArray<ParityLiveTurn>;
  /** Milliseconds from `interruptTurn` to the interrupted turn's terminal event. */
  readonly interruptMs: ReadonlyArray<number | null>;
  /** Turn items still pending, running or waiting after the scenario settled. */
  readonly stuckItems: number;
  readonly itemCounts: Readonly<Record<string, number>>;
}

interface OpenTurn {
  readonly startedAt: number;
  firstActivityAt: number | null;
  firstTextAt: number | null;
  terminalAt: number | null;
  status: string | null;
}

function isTextEvent(event: ProviderAdapter.ProviderAdapterV2Event): boolean {
  switch (event.type) {
    case "message.updated":
      return event.message.role === "assistant";
    case "turn_item.updated":
      return event.turnItem.type === "assistant_message";
    case "output.progress":
      return event.chars > 0;
    default:
      return false;
  }
}

function isActivityEvent(event: ProviderAdapter.ProviderAdapterV2Event): boolean {
  switch (event.type) {
    case "message.updated":
      return event.message.role === "assistant";
    case "turn_item.updated":
      return event.turnItem.type !== "user_message";
    case "output.progress":
    case "command_output.delta":
    case "plan.updated":
    case "runtime_request.updated":
      return true;
    default:
      return false;
  }
}

const ACTIVE_ITEM_STATUSES = new Set(["pending", "running", "waiting"]);

export function makeParityLiveTimer(now: () => number = () => performance.now()) {
  const startedAtIso = new Date().toISOString();
  const origin = now();
  const sessionOpenMs: Array<number> = [];
  const turns: Array<OpenTurn> = [];
  const pendingInterrupts: Array<number> = [];
  const interruptMs: Array<number | null> = [];
  const openTurn = () => turns.find((turn) => turn.terminalAt === null);

  const observe = (event: ProviderAdapter.ProviderAdapterV2Event) => {
    const at = now();
    const turn = openTurn();
    if (turn === undefined) return;
    if (turn.firstActivityAt === null && isActivityEvent(event)) turn.firstActivityAt = at;
    if (turn.firstTextAt === null && isTextEvent(event)) turn.firstTextAt = at;
    if (event.type === "turn.terminal") {
      turn.terminalAt = at;
      turn.status = event.status;
      const interruptedAt = pendingInterrupts.shift();
      if (interruptedAt !== undefined) interruptMs.push(Math.round(at - interruptedAt));
    }
  };

  const mark = <A, E, R>(effect: Effect.Effect<A, E, R>, onCall: () => void) =>
    Effect.suspend(() => {
      onCall();
      return effect;
    });

  /** Times sessions and turns of every session the adapter opens. */
  const wrapAdapter = (
    adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    ...adapter,
    openSession: (input) =>
      Effect.suspend(() => {
        const openedAt = now();
        return adapter.openSession(input).pipe(
          Effect.tap(() => Effect.sync(() => sessionOpenMs.push(Math.round(now() - openedAt)))),
          Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
            ...session,
            events: session.events.pipe(Stream.tap((event) => Effect.sync(() => observe(event)))),
            startTurn: (turnInput) =>
              mark(session.startTurn(turnInput), () =>
                turns.push({
                  startedAt: now(),
                  firstActivityAt: null,
                  firstTextAt: null,
                  terminalAt: null,
                  status: null,
                }),
              ),
            interruptTurn: (turnInput) =>
              mark(session.interruptTurn(turnInput), () => pendingInterrupts.push(now())),
          })),
        );
      }),
  });

  const report = (input: {
    readonly driver: string;
    readonly scenario: string;
    readonly model: string;
    readonly assertion: string | null;
    readonly failure: unknown;
    readonly result: OrchestratorV2ScenarioResult | undefined;
  }): ParityLiveReport => {
    const items = [...(input.result?.projections.values() ?? [])].flatMap(
      (projection) => projection.turnItems,
    );
    const itemCounts: Record<string, number> = {};
    for (const item of items) itemCounts[item.type] = (itemCounts[item.type] ?? 0) + 1;
    const since = (turn: OpenTurn, at: number | null) =>
      at === null ? null : Math.round(at - turn.startedAt);
    return {
      kind: "t3-parity-live",
      version: 1,
      driver: input.driver,
      scenario: input.scenario,
      model: input.model,
      passed: input.failure === undefined,
      assertion: input.assertion,
      failure:
        input.failure === undefined
          ? null
          : input.failure instanceof Error
            ? input.failure.message
            : String(input.failure),
      startedAt: startedAtIso,
      wallMs: Math.round(now() - origin),
      sessionOpenMs,
      turns: turns.map((turn) => ({
        firstActivityMs: since(turn, turn.firstActivityAt),
        firstTextMs: since(turn, turn.firstTextAt),
        terminalMs: since(turn, turn.terminalAt),
        status: turn.status,
      })),
      interruptMs: [...interruptMs, ...pendingInterrupts.map(() => null)],
      stuckItems: items.filter((item) => ACTIVE_ITEM_STATUSES.has(item.status)).length,
      itemCounts,
    };
  };

  return { wrapAdapter, report };
}

/** Reads `--report <file>`; recorders write a report there instead of failing when it is set. */
export function parityReportPath(argv: ReadonlyArray<string> = process.argv): string | undefined {
  const index = argv.indexOf("--report");
  return index === -1 ? undefined : argv[index + 1];
}

export function writeParityLiveReport(path: string, report: ParityLiveReport): void {
  NodeFS.writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** The providers Hermes is measured against; a scenario is at parity when it passes one of theirs. */
const PARITY_REFERENCE_DRIVERS: ReadonlyArray<string> = ["claudeAgent", "codex"];

type AssertOutput = ProviderOrchestratorReplayVariant["assertOutput"];

export interface ParityAssertion {
  /** The driver whose fixture variant owns the assertion. */
  readonly owner: string;
  readonly assertOutput: AssertOutput;
}

/**
 * The assertions a live run of `driver` is checked against: its own variant's when the fixture has
 * one, otherwise every reference provider's, so a scenario Hermes has never recorded is still scored.
 */
export function parityAssertions(
  fixture: OrchestratorReplayFixture,
  driver: string,
): ReadonlyArray<ParityAssertion> {
  const own = fixture.providers.find((provider) => provider.driver === driver);
  if (own !== undefined) return [{ owner: driver, assertOutput: own.assertOutput }];
  return fixture.providers
    .filter((provider) => PARITY_REFERENCE_DRIVERS.includes(provider.driver))
    .map((provider) => ({ owner: provider.driver, assertOutput: provider.assertOutput }));
}

/** Runs each assertion in turn; the owner of the first that passes, or every owner's failure. */
export function checkLiveOutput(
  assertions: ReadonlyArray<ParityAssertion>,
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
): { readonly passedOwner: string | null; readonly failure: unknown } {
  const failures: Array<string> = [];
  for (const assertion of assertions) {
    try {
      assertion.assertOutput(result, transcript);
      return { passedOwner: assertion.owner, failure: undefined };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failures.push(`${assertion.owner}: ${message.split("\n")[0]}`);
    }
  }
  return {
    passedOwner: null,
    failure: new Error(failures.join("\n") || `No assertions for ${transcript.scenario}.`),
  };
}
