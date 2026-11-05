// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off - An eval script driving child processes and a local server.
/**
 * Everything the eval runs or reads: the fixture inventory, Hermes replays, live recorder runs,
 * the stack suite against a fresh server, and the developer's field history.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readDatabaseMetrics } from "./metrics.ts";
import type { Inventory, LiveReport, ProviderMetrics, ReplayResults } from "./score.ts";

export const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const SERVER_DIR = NodePath.join(REPO_ROOT, "apps/server");
const VP = NodePath.join(REPO_ROOT, "node_modules/.bin/vp");

/** Variables that would point a child process at the developer's live T3 home. */
function isolatedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("T3HERMES_") && key !== "T3CODE_HOME" && key !== "T3_BOOT_SERVICE_UNIT",
      ),
    ),
    ...extra,
  };
}

export function readInventory(): Inventory {
  const result = NodeChildProcess.spawnSync(process.execPath, ["scripts/parity-inventory.ts"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`parity-inventory failed:\n${result.stderr.slice(-4000)}`);
  }
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("{"));
  if (line === undefined) throw new Error("parity-inventory printed no JSON.");
  return JSON.parse(line) as Inventory;
}

const REPLAY_TEST_FILES: Readonly<Record<string, string>> = {
  hermes: "apps/server/src/orchestration-v2/testkit/HermesReplayFixtures.integration.test.ts",
  claudeAgent: "apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts",
  codex: "apps/server/src/orchestration-v2/testkit/CodexReplayFixtures.integration.test.ts",
};
const REPLAY_TITLE = /^runs (.+?)\/([A-Za-z]+) through OrchestratorV2 using deterministic replay$/u;

interface VitestJson {
  readonly testResults: ReadonlyArray<{
    readonly assertionResults: ReadonlyArray<{
      readonly title: string;
      readonly status: string;
      readonly failureMessages?: ReadonlyArray<string>;
    }>;
  }>;
}

/** Parses vitest's JSON report into `scenario/driver` replay results. */
export function parseReplayReport(report: VitestJson): ReplayResults {
  const results = new Map<string, { passed: boolean; failure?: string }>();
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      const match = REPLAY_TITLE.exec(test.title);
      if (match === null) continue;
      const failure = test.failureMessages?.[0];
      results.set(`${match[1]}/${match[2]}`, {
        passed: test.status === "passed",
        ...(failure === undefined ? {} : { failure }),
      });
    }
  }
  return results;
}

/** Replays committed fixtures for `drivers`; references are narrowed to the scored scenarios. */
export function runReplays(input: {
  readonly outDir: string;
  readonly drivers: ReadonlyArray<string>;
  readonly referenceScenarios: ReadonlyArray<string>;
}): ReplayResults {
  const merged = new Map<string, { passed: boolean; failure?: string }>();
  for (const driver of input.drivers) {
    const file = REPLAY_TEST_FILES[driver];
    if (file === undefined) continue;
    const outputFile = NodePath.join(input.outDir, `replay-${driver}.json`);
    const filter =
      driver === "hermes"
        ? []
        : ["-t", `runs (${input.referenceScenarios.map(escapeRegExp).join("|")})/${driver} `];
    // A failing replay exits non-zero; the JSON report is what counts.
    NodeChildProcess.spawnSync(
      VP,
      ["test", "run", file, "--reporter=json", `--outputFile=${outputFile}`, ...filter],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (!NodeFS.existsSync(outputFile)) throw new Error(`Replay for ${driver} wrote no report.`);
    for (const [key, value] of parseReplayReport(
      JSON.parse(NodeFS.readFileSync(outputFile, "utf8")),
    )) {
      merged.set(key, value);
    }
  }
  return merged;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function readLiveReports(dir: string): Array<LiveReport> {
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const report = JSON.parse(
          NodeFS.readFileSync(NodePath.join(dir, name), "utf8"),
        ) as LiveReport & {
          readonly kind?: string;
        };
        return report.kind === "t3-parity-live" ? [report] : [];
      } catch {
        return [];
      }
    });
}

/** Records each scenario live against the benchmark Hermes home, `samples` times. */
export function runLive(input: {
  readonly outDir: string;
  readonly scenarios: ReadonlyArray<string>;
  readonly samples: number;
  readonly hermesHome: string;
}): Array<LiveReport> {
  const dir = NodePath.join(input.outDir, "live");
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const scenario of input.scenarios) {
    for (let sample = 1; sample <= input.samples; sample += 1) {
      const base = NodePath.join(dir, `hermes.${scenario}.${sample}`);
      process.stderr.write(`live hermes ${scenario} #${sample}\n`);
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "scripts/record-hermes-acp-replay-fixture.ts",
          "--hermes-home",
          input.hermesHome,
          "--scenario",
          scenario,
          "--report",
          `${base}.json`,
          "--out",
          `${base}.ndjson`,
        ],
        { cwd: SERVER_DIR, encoding: "utf8", timeout: 10 * 60_000, env: isolatedEnvironment() },
      );
      NodeFS.writeFileSync(`${base}.log`, `${result.stdout}\n${result.stderr}`);
    }
  }
  return readLiveReports(dir);
}

export interface StackProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
}

const STACK_PROMPTS = {
  cold: "Respond with exactly: parity stack ok",
  warm: "Respond with exactly: parity warm ok",
  tool: "Run the shell command `echo parity-tool` and then respond with exactly: parity tool ok",
} as const;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}

function runCli(args: ReadonlyArray<string>, cwd: string, home: string) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(SERVER_DIR, "src/bin.ts"), ...args, "--base-dir", home],
    {
      cwd,
      encoding: "utf8",
      timeout: 10 * 60_000,
      env: isolatedEnvironment(),
    },
  );
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

export async function runStackSuite(input: {
  readonly outDir: string;
  readonly samples: number;
  readonly providers: ReadonlyArray<StackProvider>;
  readonly hermesHome: string;
}): Promise<Record<string, ProviderMetrics>> {
  const dir = NodePath.join(input.outDir, "stack");
  const home = NodePath.join(dir, "home");
  const project = NodePath.join(dir, "project");
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.mkdirSync(project, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# Parity stack suite\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=parity", "-c", "user.email=parity@example.invalid", "commit", "-qm", "init"],
  ]) {
    NodeChildProcess.spawnSync("git", args, { cwd: project });
  }
  NodeFS.writeFileSync(
    NodePath.join(home, "userdata", "settings.json"),
    `${JSON.stringify(
      {
        providerInstances: Object.fromEntries(
          input.providers.map((provider) => [
            provider.instanceId,
            {
              driver: provider.driver,
              enabled: true,
              ...(provider.driver === "hermes"
                ? { environment: [{ name: "HERMES_HOME", value: input.hermesHome }] }
                : {}),
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );

  const port = await freePort();
  const log = NodePath.join(dir, "server.log");
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(SERVER_DIR, "src/bin.ts"),
      "serve",
      "--base-dir",
      home,
      "--port",
      String(port),
      "--no-browser",
    ],
    { cwd: project, env: isolatedEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const output: Array<string> = [];
  server.stdout.on("data", (chunk) => output.push(String(chunk)));
  server.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    await waitForServer(port, server);
    // Headless serve never bootstraps a project from its cwd.
    const added = runCli(["project", "add", project, "--title", "parity-stack"], project, home);
    if (!added.ok)
      throw new Error(`Could not add the stack project:\n${added.stderr.slice(-2000)}`);
    for (const provider of input.providers) {
      for (let sample = 1; sample <= input.samples; sample += 1) {
        process.stderr.write(`stack ${provider.instanceId} #${sample}\n`);
        const started = runCli(
          [
            "thread",
            "start",
            project,
            STACK_PROMPTS.cold,
            "--provider",
            provider.instanceId,
            "--model",
            provider.model,
            "--wait",
            "--json",
          ],
          project,
          home,
        );
        const threadId = /"threadId"\s*:\s*"([^"]+)"/u.exec(started.stdout)?.[1];
        NodeFS.writeFileSync(
          NodePath.join(dir, `${provider.instanceId}.${sample}.start.log`),
          `${started.stdout}\n${started.stderr}`,
        );
        if (threadId === undefined) continue;
        for (const prompt of [STACK_PROMPTS.warm, STACK_PROMPTS.tool]) {
          const sent = runCli(
            ["thread", "send", threadId, prompt, "--wait", "--json"],
            project,
            home,
          );
          NodeFS.writeFileSync(
            NodePath.join(dir, `${provider.instanceId}.${sample}.send.log`),
            `${sent.stdout}\n${sent.stderr}`,
            { flag: "a" },
          );
        }
      }
    }
  } finally {
    // Only the server this suite spawned.
    server.kill("SIGTERM");
    await new Promise((done) => {
      if (server.exitCode !== null) return done(undefined);
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        done(undefined);
      }, 15_000);
      server.once("exit", () => {
        clearTimeout(timer);
        done(undefined);
      });
    });
    NodeFS.writeFileSync(log, output.join(""));
  }
  return readStackMetrics(input.outDir, input.providers)!;
}

/** Metrics from a stack suite already run into `outDir`, or null when there is none. */
export function readStackMetrics(
  outDir: string,
  providers: ReadonlyArray<StackProvider>,
): Record<string, ProviderMetrics> | null {
  const databasePath = NodePath.join(outDir, "stack", "home", "userdata", "statev2.sqlite");
  if (!NodeFS.existsSync(databasePath)) return null;
  return readDatabaseMetrics({
    databasePath,
    sinceIso: "1970-01-01T00:00:00.000Z",
    providers: [...new Set(providers.map((provider) => provider.driver))],
  });
}

async function waitForServer(port: number, server: NodeChildProcess.ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Stack server exited with ${server.exitCode}.`);
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error("Stack server did not start within 2 minutes.");
}

/** The developer's own T3 Hermes home: the field layer only ever reads it. */
export const DEFAULT_FIELD_DATABASE = NodePath.join(
  process.env.T3HERMES_HOME ?? NodePath.join(NodeOS.homedir(), ".t3-hermes"),
  "userdata/statev2.sqlite",
);

export function readField(input: {
  readonly databasePath: string;
  readonly sinceDays: number;
}): Record<string, ProviderMetrics> {
  const since = new Date(Date.now() - input.sinceDays * 86_400_000).toISOString();
  return readDatabaseMetrics({
    databasePath: input.databasePath,
    sinceIso: since,
    providers: ["claudeAgent", "codex", "hermes"],
  });
}
