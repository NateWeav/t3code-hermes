#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - An eval script, not server code.
/**
 * Scores how close the Hermes provider is to Claude and Codex; flags are in README.md.
 *   pnpm provider-parity --out runs/<name> [--baseline runs/<prev>] [--live] [--stack] [--field]
 * Without flags it replays committed fixtures only: free, deterministic, about a minute.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_FIELD_DATABASE,
  readField,
  readInventory,
  readLiveReports,
  readStackMetrics,
  runLive,
  runReplays,
  runStackSuite,
  type StackProvider,
} from "./collect.ts";
import { PARITY_SCENARIOS } from "./scenarios.ts";
import {
  buildScorecard,
  REFERENCES,
  renderSummary,
  type Inventory,
  type Scorecard,
} from "./score.ts";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(name) || process.argv.includes("--all");
const expandHome = (path: string) =>
  NodePath.resolve(path.replace(/^~(?=$|\/)/u, NodeOS.homedir()));

const outArg = argValue("--out");
if (outArg === undefined) throw new Error("Pass --out <dir>, e.g. --out runs/baseline.");
const outDir = NodePath.resolve(outArg);
NodeFS.mkdirSync(outDir, { recursive: true });
const hermesHome = expandHome(
  argValue("--hermes-home") ?? process.env.T3_HERMES_BENCH_HOME ?? "~/.hermes-bench",
);

/** Every scenario a reference provider covers must be classified, so none drops out silently. */
function assertManifestCoversInventory(inventory: Inventory): void {
  const classified = new Set(PARITY_SCENARIOS.map((scenario) => scenario.name));
  const missing = inventory.scenarios
    .filter((scenario) =>
      scenario.variants.some((variant) =>
        (REFERENCES as ReadonlyArray<string>).includes(variant.driver),
      ),
    )
    .map((scenario) => scenario.name)
    .filter((name) => !classified.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Classify these scenarios in evals/provider-parity/scenarios.ts: ${missing.join(", ")}`,
    );
  }
}

const inventory = readInventory();
assertManifestCoversInventory(inventory);
NodeFS.writeFileSync(
  NodePath.join(outDir, "inventory.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
);

const scored = PARITY_SCENARIOS.filter((scenario) => scenario.hermes.kind !== "na");
const replay = runReplays({
  outDir,
  drivers: has("--references") ? ["hermes", ...REFERENCES] : ["hermes"],
  referenceScenarios: scored.map((scenario) => scenario.name),
});

const selected = argValue("--scenario")?.split(",");
const liveScenarios = scored
  .flatMap(({ name, hermes }) =>
    hermes.kind === "applicable"
      ? [name]
      : hermes.kind === "twin" && hermes.twin
        ? [hermes.twin]
        : [],
  )
  .filter((name) => selected === undefined || selected.includes(name));
const live = has("--live")
  ? runLive({
      outDir,
      scenarios: liveScenarios,
      samples: Number(argValue("--samples") ?? 1),
      hermesHome,
    })
  : readLiveReports(NodePath.join(outDir, "live"));

const stackProviders: ReadonlyArray<StackProvider> = [
  {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    model: argValue("--claude-model") ?? "claude-haiku-5-5",
  },
  { instanceId: "codex", driver: "codex", model: argValue("--codex-model") ?? "gpt-6-luna" },
  {
    instanceId: "hermes",
    driver: "hermes",
    model: argValue("--hermes-model") ?? "custom:cliproxyapi-claude:claude-haiku-5-5",
  },
];
const stack = has("--stack")
  ? await runStackSuite({
      outDir,
      samples: Number(argValue("--stack-samples") ?? 3),
      providers: stackProviders,
      hermesHome,
    })
  : readStackMetrics(outDir, stackProviders);

const fieldDatabase = expandHome(argValue("--db") ?? DEFAULT_FIELD_DATABASE);
const field =
  has("--field") && NodeFS.existsSync(fieldDatabase)
    ? readField({ databasePath: fieldDatabase, sinceDays: Number(argValue("--since-days") ?? 30) })
    : null;

const card = buildScorecard({
  manifest: PARITY_SCENARIOS,
  inventory,
  replay,
  live,
  stack,
  field,
  createdAt: new Date().toISOString(),
});

function readBaseline(): Scorecard | undefined {
  const raw = argValue("--baseline");
  if (raw === undefined) return undefined;
  const path = NodePath.resolve(raw);
  const file = NodeFS.statSync(path).isDirectory() ? NodePath.join(path, "scorecard.json") : path;
  return JSON.parse(NodeFS.readFileSync(file, "utf8")) as Scorecard;
}

const summary = renderSummary(card, readBaseline());
NodeFS.writeFileSync(NodePath.join(outDir, "scorecard.json"), `${JSON.stringify(card, null, 2)}\n`);
NodeFS.writeFileSync(NodePath.join(outDir, "summary.md"), summary);
process.stdout.write(
  `${summary}\nWrote ${NodePath.join(outDir, "scorecard.json")} and summary.md\n`,
);
