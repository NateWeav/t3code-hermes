/**
 * Pure scoring for the provider-parity eval: inputs are the replay inventory and results, live
 * recorder reports, and per-provider run metrics; the output is one scorecard and its summary.
 */
import { FACETS, type Facet, type ParityScenario } from "./scenarios.ts";

export const HERMES = "hermes";
export const REFERENCES = ["claudeAgent", "codex"] as const;
/** Latency is compared with Claude: the benchmark runs both on the same model. */
export const LATENCY_REFERENCE = "claudeAgent";
/** "On par with Claude Code": parity on every scored scenario Claude has a fixture for. */
const CLAUDE = "claudeAgent";

export interface InventoryVariant {
  readonly driver: string;
  readonly model: string;
  readonly assertionId: number;
  readonly assertionName: string;
  readonly transcriptExists: boolean;
}
export interface Inventory {
  readonly scenarios: ReadonlyArray<{
    readonly name: string;
    readonly variants: ReadonlyArray<InventoryVariant>;
  }>;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** Keyed `scenario/driver`, as the replay test names them. */
export type ReplayResults = ReadonlyMap<
  string,
  { readonly passed: boolean; readonly failure?: string }
>;

export interface LiveReport {
  readonly driver: string;
  readonly scenario: string;
  readonly passed: boolean;
  readonly assertion: string | null;
  readonly failure: string | null;
  readonly sessionOpenMs: ReadonlyArray<number>;
  readonly turns: ReadonlyArray<{
    readonly firstActivityMs: number | null;
    readonly firstTextMs: number | null;
    readonly terminalMs: number | null;
  }>;
  readonly interruptMs: ReadonlyArray<number | null>;
  readonly stuckItems: number;
}

export interface Stats {
  readonly n: number;
  readonly p50: number | null;
  readonly p90: number | null;
}

/** Run metrics for one provider, from any T3 database (field history or the stack suite). */
export interface ProviderMetrics {
  readonly runs: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly interrupted: number;
  /** Send to the run starting, first run of a thread (session start included). */
  readonly coldStartMs: Stats;
  /** Send to the run starting, later runs not queued behind another. */
  readonly warmStartMs: Stats;
  /** Send to the first visible agent row (text, reasoning, or a tool), by the same split. */
  readonly coldFirstActivityMs: Stats;
  readonly warmFirstActivityMs: Stats;
  /** Send to the first assistant text, by the same split. */
  readonly coldFirstTextMs: Stats;
  readonly warmFirstTextMs: Stats;
  readonly runMs: Stats;
  readonly reasoningPerAssistantMessage: number | null;
  /** Share of tool rows with a typed card (command, file change, search) rather than a generic one. */
  readonly typedToolShare: number | null;
  readonly errorItemsPerRun: number | null;
  /** Rows still pending, running or waiting under a finished run. */
  readonly stuckItems: number;
}

export function stats(values: ReadonlyArray<number>): Stats {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length === 0
      ? null
      : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9) };
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

const NEGATIVE_FLAGS = new Set([
  "approvals.approvalCallbacksAreLiveOnly",
  "turns.activeSteeringInterruptsTools",
]);
const LEVELS: Readonly<Record<string, number>> = {
  none: 0,
  weak: 1,
  strong: 2,
  "client-boundary": 0,
  native: 1,
};

/** Flattens a capabilities object to `group.flag` paths. */
export function flattenCapabilities(value: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      for (const [inner, innerValue] of flattenCapabilities(entry, path))
        out.set(inner, innerValue);
    } else {
      out.set(path, entry);
    }
  }
  return out;
}

/** Higher is better; undefined when the value cannot be ranked. */
export function capabilityRank(path: string, value: unknown): number | undefined {
  if (value === undefined) return NEGATIVE_FLAGS.has(path) ? 1 : 0;
  if (typeof value === "boolean") return NEGATIVE_FLAGS.has(path) ? (value ? 0 : 1) : value ? 1 : 0;
  // A null handoff budget means unlimited.
  if (value === null) return 1;
  if (typeof value === "number") return 0;
  if (typeof value === "string") return LEVELS[value];
  return undefined;
}

export interface CapabilityGap {
  readonly path: string;
  readonly vs: string;
  readonly hermes: unknown;
  readonly reference: unknown;
}

export function diffCapabilities(capabilities: Readonly<Record<string, unknown>>): {
  readonly behind: ReadonlyArray<CapabilityGap>;
  readonly ahead: ReadonlyArray<CapabilityGap>;
} {
  const hermes = flattenCapabilities(capabilities[HERMES]);
  const behind: Array<CapabilityGap> = [];
  const ahead: Array<CapabilityGap> = [];
  // Active-steering quirks mean nothing to a provider that cannot steer actively.
  const vacuous = (path: string) =>
    path.startsWith("turns.activeSteering") && hermes.get("turns.supportsActiveSteering") !== true;
  for (const vs of REFERENCES) {
    const reference = flattenCapabilities(capabilities[vs]);
    for (const path of new Set([...hermes.keys(), ...reference.keys()])) {
      if (vacuous(path)) continue;
      const ours = capabilityRank(path, hermes.get(path));
      const theirs = capabilityRank(path, reference.get(path));
      if (ours === undefined || theirs === undefined || ours === theirs) continue;
      const gap = { path, vs, hermes: hermes.get(path), reference: reference.get(path) };
      (ours < theirs ? behind : ahead).push(gap);
    }
  }
  return { behind, ahead };
}

export type ConformanceStatus =
  | "parity"
  | "divergent"
  | "failing"
  | "missing"
  | "twin-missing"
  | "na"
  | "no-reference";

const PROVIDER_BOUND_REASON =
  "Every reference assertion checks its own provider's identity, wire frames or item shapes, so no Hermes run can pass one.";

/** Points per status; `null` is excluded from the facet's denominator. */
const STATUS_POINTS: Readonly<Record<ConformanceStatus, number | null>> = {
  parity: 1,
  divergent: 0.5,
  failing: 0,
  missing: 0,
  "twin-missing": 0,
  na: null,
  "no-reference": null,
};

export interface LiveSummary {
  readonly samples: number;
  readonly passed: number;
  readonly assertion: string | null;
  readonly failure: string | null;
}

export interface ScenarioScore {
  readonly name: string;
  readonly facet: Facet;
  readonly status: ConformanceStatus;
  readonly points: number | null;
  /** Which committed scenario holds Hermes's result: this one, or its Hermes twin. */
  readonly scoredAs: string;
  readonly references: ReadonlyArray<{ readonly driver: string; readonly replay: boolean | null }>;
  readonly hermesAssertion: string | null;
  readonly failure: string | null;
  readonly reason: string | null;
  readonly live: LiveSummary | null;
}

export function summarizeLive(
  reports: ReadonlyArray<LiveReport>,
  scenario: string,
  driver = HERMES,
): LiveSummary | null {
  const mine = reports.filter((report) => report.scenario === scenario && report.driver === driver);
  if (mine.length === 0) return null;
  const passing = mine.filter((report) => report.passed);
  return {
    samples: mine.length,
    passed: passing.length,
    assertion: passing[0]?.assertion ?? null,
    failure: mine.find((report) => !report.passed)?.failure ?? null,
  };
}

export function scoreScenario(input: {
  readonly scenario: ParityScenario;
  readonly inventory: Inventory;
  readonly replay: ReplayResults;
  readonly live: ReadonlyArray<LiveReport>;
}): ScenarioScore {
  const { scenario, inventory, replay } = input;
  const variantsOf = (name: string) =>
    inventory.scenarios.find((candidate) => candidate.name === name)?.variants ?? [];
  const referenceVariants = variantsOf(scenario.name).filter((variant) =>
    (REFERENCES as ReadonlyArray<string>).includes(variant.driver),
  );
  const references = referenceVariants.map((variant) => ({
    driver: variant.driver,
    replay: replay.get(`${scenario.name}/${variant.driver}`)?.passed ?? null,
  }));
  const scoredAs =
    scenario.hermes.kind === "twin" && scenario.hermes.twin !== undefined
      ? scenario.hermes.twin
      : scenario.name;
  const live = summarizeLive(input.live, scoredAs);
  const base = {
    name: scenario.name,
    facet: scenario.facet,
    scoredAs,
    references,
    live,
  };
  const result = (
    status: ConformanceStatus,
    rest: Partial<Pick<ScenarioScore, "hermesAssertion" | "failure" | "reason">> = {},
  ): ScenarioScore => ({
    ...base,
    status,
    points: STATUS_POINTS[status],
    hermesAssertion: rest.hermesAssertion ?? null,
    failure: rest.failure ?? null,
    reason: rest.reason ?? null,
  });

  if (scenario.hermes.kind === "na") return result("na", { reason: scenario.hermes.reason });
  if (referenceVariants.length === 0) {
    return result("no-reference", { reason: "No Claude or Codex variant to compare against." });
  }
  const hermesVariant = variantsOf(scoredAs).find((variant) => variant.driver === HERMES);
  if (hermesVariant === undefined || !hermesVariant.transcriptExists) {
    if (scenario.hermes.kind === "twin" && scenario.hermes.twin === undefined) {
      return result("twin-missing", { reason: scenario.hermes.reason });
    }
    return result("missing", {
      failure: live?.failure ?? null,
      reason: scenario.providerBound ? PROVIDER_BOUND_REASON : null,
    });
  }
  const replayed = replay.get(`${scoredAs}/${HERMES}`);
  if (replayed === undefined || !replayed.passed) {
    return result("failing", {
      hermesAssertion: hermesVariant.assertionName,
      failure: replayed?.failure ?? "Replay did not run.",
    });
  }
  const sharesContract = referenceVariants.some(
    (variant) => variant.assertionId === hermesVariant.assertionId,
  );
  return result(sharesContract ? "parity" : "divergent", {
    hermesAssertion: hermesVariant.assertionName,
  });
}

export interface FacetScore {
  readonly facet: string;
  /** 0-100, or null when nothing in the facet is scored yet. */
  readonly score: number | null;
  readonly scored: number;
  readonly points: number;
}

export function scoreFacets(scenarios: ReadonlyArray<ScenarioScore>): ReadonlyArray<FacetScore> {
  return FACETS.map((facet) => {
    const scored = scenarios.filter((score) => score.facet === facet && score.points !== null);
    const points = scored.reduce((sum, score) => sum + (score.points ?? 0), 0);
    return {
      facet,
      score: scored.length === 0 ? null : round((100 * points) / scored.length),
      scored: scored.length,
      points,
    };
  });
}

export interface LatencyComparison {
  readonly metric: string;
  readonly hermes: number | null;
  readonly reference: number | null;
  /** min(1, reference / hermes): 1 is as fast as the reference or faster. */
  readonly ratio: number | null;
}

const LATENCY_METRICS = [
  "coldFirstActivityMs",
  "warmFirstActivityMs",
  "coldFirstTextMs",
  "warmFirstTextMs",
  "runMs",
] as const satisfies ReadonlyArray<keyof ProviderMetrics>;

export function compareLatency(
  hermes: ProviderMetrics | undefined,
  reference: ProviderMetrics | undefined,
): ReadonlyArray<LatencyComparison> {
  return LATENCY_METRICS.map((metric) => {
    const ours = hermes?.[metric].p50 ?? null;
    const theirs = reference?.[metric].p50 ?? null;
    return {
      metric,
      hermes: ours,
      reference: theirs,
      ratio:
        ours === null || theirs === null
          ? null
          : ours <= 0
            ? 1
            : round(Math.min(1, theirs / ours), 3),
    };
  });
}

export function latencyScore(comparisons: ReadonlyArray<LatencyComparison>): number | null {
  const ratios = comparisons.flatMap((comparison) =>
    comparison.ratio === null ? [] : [comparison.ratio],
  );
  const average = mean(ratios);
  return average === null ? null : round(100 * average);
}

/**
 * How dependably Hermes finishes what it starts: live sample consistency on the scenarios it can
 * pass, and the stack suite's completion rate with stuck rows counted against it.
 */
export function reliabilityScore(input: {
  readonly live: ReadonlyArray<LiveSummary>;
  readonly stack: ProviderMetrics | undefined;
}): number | null {
  // One sample says nothing about consistency.
  const consistency = mean(
    input.live
      .filter((live) => live.passed > 0 && live.samples > 1)
      .map((live) => live.passed / live.samples),
  );
  const stack =
    input.stack === undefined || input.stack.runs === 0
      ? null
      : (input.stack.completed / input.stack.runs) *
        (1 - Math.min(1, input.stack.stuckItems / input.stack.runs));
  const parts = [consistency, stack].flatMap((part) => (part === null ? [] : [part]));
  const average = mean(parts);
  return average === null ? null : round(100 * average);
}

export interface Scorecard {
  readonly kind: "t3-provider-parity";
  readonly version: 1;
  readonly createdAt: string;
  readonly headline: { readonly parity: number | null; readonly facets: ReadonlyArray<string> };
  readonly facets: ReadonlyArray<FacetScore>;
  readonly claudeParity: { readonly passed: number; readonly covered: number };
  readonly scenarios: ReadonlyArray<ScenarioScore>;
  readonly capabilities: {
    readonly behind: ReadonlyArray<CapabilityGap>;
    readonly ahead: ReadonlyArray<CapabilityGap>;
    /** Declared by Hermes, exercised by a scenario Hermes does not pass. */
    readonly unbacked: ReadonlyArray<{ readonly path: string; readonly scenario: string }>;
  };
  readonly latency: {
    readonly score: number | null;
    readonly comparisons: ReadonlyArray<LatencyComparison>;
  } | null;
  readonly reliability: number | null;
  readonly stack: Readonly<Record<string, ProviderMetrics>> | null;
  readonly field: Readonly<Record<string, ProviderMetrics>> | null;
  /** Hermes adapter-level timings from the live recorder (no reference counterpart). */
  readonly liveTimings: {
    readonly sessionOpenMs: Stats;
    readonly firstTextMs: Stats;
    readonly interruptMs: Stats;
  } | null;
  readonly nextSteps: ReadonlyArray<NextStep>;
}

export interface NextStep {
  /** Headline points gained if this one item reaches parity. */
  readonly gain: number;
  readonly scenario: string;
  readonly action: string;
}

export function buildScorecard(input: {
  readonly manifest: ReadonlyArray<ParityScenario>;
  readonly inventory: Inventory;
  readonly replay: ReplayResults;
  readonly live: ReadonlyArray<LiveReport>;
  readonly stack: Readonly<Record<string, ProviderMetrics>> | null;
  readonly field: Readonly<Record<string, ProviderMetrics>> | null;
  readonly createdAt: string;
}): Scorecard {
  const scenarios = input.manifest.map((scenario) =>
    scoreScenario({ scenario, inventory: input.inventory, replay: input.replay, live: input.live }),
  );
  const facets = scoreFacets(scenarios);
  const comparisons = input.stack
    ? compareLatency(input.stack[HERMES], input.stack[LATENCY_REFERENCE])
    : null;
  const latency = comparisons === null ? null : { score: latencyScore(comparisons), comparisons };
  const liveSummaries = scenarios.flatMap((score) => (score.live === null ? [] : [score.live]));
  const reliability =
    liveSummaries.length === 0 && input.stack === null
      ? null
      : reliabilityScore({ live: liveSummaries, stack: input.stack?.[HERMES] });

  const headlineParts: Array<{ readonly name: string; readonly score: number }> = [
    ...facets.flatMap((facet) =>
      facet.score === null ? [] : [{ name: facet.facet, score: facet.score }],
    ),
    ...(latency?.score == null ? [] : [{ name: "latency", score: latency.score }]),
    ...(reliability === null ? [] : [{ name: "reliability", score: reliability }]),
  ];
  const headline = mean(headlineParts.map((part) => part.score));
  const claudeCovered = scenarios.filter(
    (score) =>
      score.points !== null && score.references.some((reference) => reference.driver === CLAUDE),
  );

  const declared = flattenCapabilities(input.inventory.capabilities[HERMES]);
  const unbacked = input.manifest.flatMap((scenario) => {
    const score = scenarios.find((candidate) => candidate.name === scenario.name);
    if (score === undefined || score.points === null || score.points > 0) return [];
    return (scenario.exercises ?? [])
      .filter((path) => capabilityRank(path, declared.get(path)) === 1)
      .map((path) => ({ path, scenario: scenario.name }));
  });

  const hermesLive = input.live.filter((report) => report.driver === HERMES);
  const liveTimings =
    hermesLive.length === 0
      ? null
      : {
          sessionOpenMs: stats(hermesLive.flatMap((report) => report.sessionOpenMs.slice(0, 1))),
          firstTextMs: stats(
            hermesLive.flatMap((report) =>
              report.turns.flatMap((turn) => (turn.firstTextMs === null ? [] : [turn.firstTextMs])),
            ),
          ),
          interruptMs: stats(
            hermesLive.flatMap((report) =>
              report.interruptMs.flatMap((ms) => (ms === null ? [] : [ms])),
            ),
          ),
        };

  return {
    kind: "t3-provider-parity",
    version: 1,
    createdAt: input.createdAt,
    headline: {
      parity: headline === null ? null : round(headline),
      facets: headlineParts.map((part) => part.name),
    },
    facets,
    claudeParity: {
      passed: claudeCovered.filter((score) => score.status === "parity").length,
      covered: claudeCovered.length,
    },
    scenarios,
    capabilities: { ...diffCapabilities(input.inventory.capabilities), unbacked },
    latency,
    reliability,
    stack: input.stack,
    field: input.field,
    liveTimings,
    nextSteps: rankNextSteps(scenarios, facets, headlineParts.length),
  };
}

function rankNextSteps(
  scenarios: ReadonlyArray<ScenarioScore>,
  facets: ReadonlyArray<FacetScore>,
  headlineParts: number,
): ReadonlyArray<NextStep> {
  const steps = scenarios.flatMap((score): ReadonlyArray<NextStep> => {
    if (score.points === null || score.points >= 1) return [];
    const facet = facets.find((candidate) => candidate.facet === score.facet);
    const perScenario = facet === undefined || facet.scored === 0 ? 0 : 100 / facet.scored;
    const gain = round(((1 - score.points) * perScenario) / Math.max(1, headlineParts), 2);
    const action = (() => {
      switch (score.status) {
        case "missing":
          if (score.reason !== null && (score.live === null || score.live.passed === 0)) {
            return `${score.reason} Move the reference's wire checks to its assertProviderDetails and share the rest as assertOutput.`;
          }
          return score.live !== null && score.live.passed > 0
            ? `Passes live (${score.live.assertion} assertion) but has no committed fixture: record it and add a hermes variant using that assertion.`
            : `Fails live${score.live?.failure ? `: ${firstLine(score.live.failure)}` : " (not run)"}. Fix the Hermes integration, then record it.`;
        case "failing":
          return `Committed fixture fails replay: ${firstLine(score.failure ?? "")}`;
        case "divergent":
          return `Passes only its own ${score.hermesAssertion}; make it meet the reference assertion.`;
        case "twin-missing":
          return `Write a Hermes-worded twin scenario that reuses the reference assertion. ${score.reason ?? ""}`.trim();
        default:
          return "";
      }
    })();
    return [{ gain, scenario: score.name, action }];
  });
  // Cheapest wins first: a live pass waiting to be recorded beats a fix of equal gain.
  const effort = (step: NextStep) => (step.action.startsWith("Passes live") ? 0 : 1);
  return [...steps].sort((a, b) => b.gain - a.gain || effort(a) - effort(b));
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

const STATUS_LABEL: Readonly<Record<ConformanceStatus, string>> = {
  parity: "parity",
  divergent: "divergent",
  failing: "FAILING",
  missing: "missing",
  "twin-missing": "needs twin",
  na: "n/a",
  "no-reference": "no reference",
};

function delta(current: number | null | undefined, previous: number | null | undefined): string {
  if (current == null || previous == null) return "";
  const change = round(current - previous);
  return change === 0 ? " (±0)" : ` (${change > 0 ? "+" : ""}${change})`;
}

const fmt = (value: number | null | undefined, unit = "") =>
  value == null ? "–" : `${Number.isInteger(value) ? value : round(value)}${unit}`;
const seconds = (ms: number | null | undefined) => (ms == null ? "–" : `${round(ms / 1000)} s`);
const percent = (value: number | null | undefined) =>
  value == null ? "–" : `${round(100 * value)}%`;

export function renderSummary(card: Scorecard, baseline?: Scorecard): string {
  const lines: Array<string> = [];
  lines.push(`# Hermes provider parity`, "");
  lines.push(
    `**Parity score: ${fmt(card.headline.parity)} / 100**${delta(card.headline.parity, baseline?.headline.parity)}`,
    "",
    `**Claude Code coverage: ${card.claudeParity.passed} / ${card.claudeParity.covered}**${delta(card.claudeParity.passed, baseline?.claudeParity?.passed)} scored scenarios with a Claude fixture are at parity.`,
    "",
    `Mean of ${card.headline.facets.length} facets: ${card.headline.facets.join(", ")}. ${card.createdAt}`,
    "",
  );

  lines.push(`## Facets`, "", `| Facet | Score | Scenarios scored |`, `| --- | --- | --- |`);
  for (const facet of card.facets) {
    const before = baseline?.facets.find((candidate) => candidate.facet === facet.facet);
    lines.push(
      `| ${facet.facet} | ${fmt(facet.score)}${delta(facet.score, before?.score)} | ${round(facet.points)} / ${facet.scored} |`,
    );
  }
  if (card.latency !== null) {
    lines.push(
      `| latency | ${fmt(card.latency.score)}${delta(card.latency.score, baseline?.latency?.score)} | vs Claude, same model |`,
    );
  }
  if (card.reliability !== null) {
    lines.push(
      `| reliability | ${fmt(card.reliability)}${delta(card.reliability, baseline?.reliability)} | live consistency, stack completion |`,
    );
  }
  lines.push("");

  lines.push(`## Next steps`, "", `Ranked by headline points gained.`, "");
  for (const step of card.nextSteps.slice(0, 15)) {
    lines.push(`- **+${step.gain}** \`${step.scenario}\`: ${step.action}`);
  }
  lines.push("");

  if (baseline !== undefined) {
    const regressions = card.scenarios.filter((score) => {
      const before = baseline.scenarios.find((candidate) => candidate.name === score.name);
      return before?.points != null && score.points != null && score.points < before.points;
    });
    if (regressions.length > 0) {
      lines.push(`## Regressions`, "");
      for (const score of regressions) {
        const before = baseline.scenarios.find((candidate) => candidate.name === score.name);
        lines.push(`- \`${score.name}\`: ${before?.status} → ${score.status}`);
      }
      lines.push("");
    }
  }

  lines.push(
    `## Scenarios`,
    "",
    `| Scenario | Facet | Hermes | Live | Claude | Codex | Note |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  );
  const ref = (score: ScenarioScore, driver: string) => {
    const reference = score.references.find((candidate) => candidate.driver === driver);
    return reference === undefined
      ? ""
      : reference.replay === null
        ? "fixture"
        : reference.replay
          ? "pass"
          : "FAIL";
  };
  for (const score of card.scenarios) {
    const live = score.live === null ? "" : `${score.live.passed}/${score.live.samples}`;
    const note = score.reason ?? (score.failure ? firstLine(score.failure) : "");
    lines.push(
      `| \`${score.name}\` | ${score.facet} | ${STATUS_LABEL[score.status]} | ${live} | ${ref(score, "claudeAgent")} | ${ref(score, "codex")} | ${note.replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");

  if (card.latency !== null) {
    lines.push(
      `## Latency (stack suite, p50)`,
      "",
      `| Metric | Hermes | Claude | Ratio |`,
      `| --- | --- | --- | --- |`,
    );
    for (const comparison of card.latency.comparisons) {
      lines.push(
        `| ${comparison.metric} | ${seconds(comparison.hermes)} | ${seconds(comparison.reference)} | ${fmt(comparison.ratio)} |`,
      );
    }
    lines.push("");
  }

  const metricsTable = (title: string, metrics: Readonly<Record<string, ProviderMetrics>>) => {
    const providers = Object.keys(metrics).sort();
    lines.push(
      `## ${title}`,
      "",
      `| Metric | ${providers.join(" | ")} |`,
      `| --- |${providers.map(() => " --- |").join("")}`,
    );
    const row = (label: string, read: (metric: ProviderMetrics) => string) =>
      lines.push(
        `| ${label} | ${providers.map((provider) => read(metrics[provider]!)).join(" | ")} |`,
      );
    row("runs", (metric) => String(metric.runs));
    row("failed", (metric) => percent(metric.runs === 0 ? null : metric.failed / metric.runs));
    row("cancelled or interrupted", (metric) =>
      percent(metric.runs === 0 ? null : (metric.cancelled + metric.interrupted) / metric.runs),
    );
    row("cold start p50", (metric) => seconds(metric.coldStartMs.p50));
    row("warm start p50", (metric) => seconds(metric.warmStartMs.p50));
    row("cold first activity p50", (metric) => seconds(metric.coldFirstActivityMs.p50));
    row("warm first activity p50", (metric) => seconds(metric.warmFirstActivityMs.p50));
    row("cold first text p50", (metric) => seconds(metric.coldFirstTextMs.p50));
    row("warm first text p50", (metric) => seconds(metric.warmFirstTextMs.p50));
    row("run p50", (metric) => seconds(metric.runMs.p50));
    row("reasoning rows per reply", (metric) => fmt(metric.reasoningPerAssistantMessage));
    row("typed tool cards", (metric) => percent(metric.typedToolShare));
    row("error rows per run", (metric) => fmt(metric.errorItemsPerRun));
    row("stuck rows", (metric) => String(metric.stuckItems));
    lines.push("");
  };
  if (card.stack !== null) metricsTable("Stack suite", card.stack);
  if (card.field !== null)
    metricsTable("Field (your real history, tracked not scored)", card.field);

  if (card.liveTimings !== null) {
    lines.push(
      `## Hermes adapter timings (live recorder)`,
      "",
      `Session open p50 ${seconds(card.liveTimings.sessionOpenMs.p50)} (n=${card.liveTimings.sessionOpenMs.n}), first text p50 ${seconds(card.liveTimings.firstTextMs.p50)}, interrupt to settled p50 ${seconds(card.liveTimings.interruptMs.p50)} (n=${card.liveTimings.interruptMs.n}).`,
      "",
    );
  }

  lines.push(`## Declared capabilities`, "");
  const byReference = (vs: string) => card.capabilities.behind.filter((gap) => gap.vs === vs);
  for (const vs of REFERENCES) {
    const gaps = byReference(vs);
    lines.push(
      `- Behind ${vs} on ${gaps.length}: ${gaps.map((gap) => `\`${gap.path}\``).join(", ") || "none"}`,
    );
  }
  const ahead = card.capabilities.ahead.map((gap) => `\`${gap.path}\` (vs ${gap.vs})`);
  lines.push(`- Ahead on: ${ahead.join(", ") || "none"}`);
  if (card.capabilities.unbacked.length > 0) {
    lines.push(
      `- Declared but not shown by a passing scenario: ${card.capabilities.unbacked.map((entry) => `\`${entry.path}\` (${entry.scenario})`).join(", ")}`,
    );
  }
  lines.push("", `Declared flags are a gap map, not a score.`, "");
  return lines.join("\n");
}
