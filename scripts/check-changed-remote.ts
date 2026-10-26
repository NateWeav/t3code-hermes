// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fork: check:changed runs CI on GitHub so agents stop stacking knip, tsc and vitest on small
// machines. It pushes the working tree, uncommitted and untracked files included, to a throwaway
// ci-check/* branch, dispatches CI there, prints failed job logs, and deletes the branch.
// `--local` runs scripts/check-changed.ts on this machine instead.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const root = NodePath.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

if (args.includes("--local")) {
  const { status } = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, "scripts/check-changed.ts"), ...args.filter((arg) => arg !== "--local")],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(status ?? 1);
}
if (args.length > 0) {
  console.log(`check:changed: CI runs the full suite on GitHub, so ${args.join(" ")} is ignored.`);
}

const run = (command: string, commandArgs: Array<string>, env = process.env) => {
  const result = NodeChildProcess.spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed:\n${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  return result.stdout.trim();
};

const repo = run("git", ["remote", "get-url", "origin"]).match(
  /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
)?.[1];
if (!repo) {
  console.error("check:changed: origin is not a GitHub repository. Run with --local.");
  process.exit(1);
}

// A copy of the real index keeps its stat cache, so `git add -A` rehashes only changed files.
const head = run("git", ["rev-parse", "HEAD"]);
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const indexDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-remote-"));
let tree: string;
try {
  const index = NodePath.join(indexDir, "index");
  NodeFS.copyFileSync(
    NodePath.resolve(root, run("git", ["rev-parse", "--git-path", "index"])),
    index,
  );
  const env = { ...process.env, GIT_INDEX_FILE: index };
  run("git", ["add", "-A"], env);
  tree = run("git", ["write-tree"], env);
} finally {
  NodeFS.rmSync(indexDir, { recursive: true, force: true });
}
const sha =
  tree === run("git", ["rev-parse", "HEAD^{tree}"])
    ? head
    : run("git", ["commit-tree", tree, "-p", head, "-m", `check:changed snapshot of ${branch}`]);
const ref = `ci-check/${branch.replace(/[^\w.-]+/g, "-")}-${sha.slice(0, 10)}`;

let runId: string | undefined;
const cleanUp = () => {
  NodeChildProcess.spawnSync(
    "git",
    ["push", "--quiet", "--no-verify", "origin", `:refs/heads/${ref}`],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (runId) {
      NodeChildProcess.spawnSync("gh", ["run", "cancel", runId, "-R", repo], { stdio: "ignore" });
    }
    cleanUp();
    process.exit(130);
  });
}

try {
  console.log(`check:changed: running CI on GitHub for ${sha.slice(0, 12)} (${branch})`);
  run("git", ["push", "--quiet", "--force", "--no-verify", "origin", `${sha}:refs/heads/${ref}`]);
  run("gh", ["workflow", "run", "ci.yml", "-R", repo, "--ref", ref]);

  // The dispatch call does not return the run, so find it by branch and commit.
  for (let attempt = 0; attempt < 30 && !runId; attempt++) {
    await NodeTimersPromises.setTimeout(2000);
    const runs: Array<{ databaseId: number; url: string }> = JSON.parse(
      run("gh", [
        "run",
        "list",
        "-R",
        repo,
        "-w",
        "ci.yml",
        "-b",
        ref,
        "-c",
        sha,
        "-e",
        "workflow_dispatch",
        "-L",
        "1",
        "--json",
        "databaseId,url",
      ]),
    );
    if (runs[0]) {
      runId = String(runs[0].databaseId);
      console.log(`check:changed: ${runs[0].url}`);
    }
  }
  if (!runId) throw new Error(`No CI run appeared for ${ref} within a minute.`);

  type Job = {
    databaseId: number;
    name: string;
    status: string;
    conclusion: string;
    startedAt: string;
    completedAt: string;
  };
  const label = (conclusion: string) =>
    conclusion === "success" ? "pass" : conclusion === "skipped" ? "skip" : "FAIL";
  const seconds = (job: Job) =>
    Math.max(0, Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000));
  const reported = new Set<string>();
  const summary: Array<string> = [];
  let view: { status: string; conclusion: string; jobs: Array<Job> };
  for (;;) {
    view = JSON.parse(
      run("gh", ["run", "view", runId, "-R", repo, "--json", "status,conclusion,jobs"]),
    );
    for (const job of view.jobs) {
      if (job.status !== "completed" || reported.has(job.name)) continue;
      reported.add(job.name);
      summary.push(`  ${label(job.conclusion)}  ${job.name}  ${seconds(job)}s`);
      console.log(summary.at(-1));
    }
    if (view.status === "completed") break;
    await NodeTimersPromises.setTimeout(15_000);
  }

  // The final Check job only restates which jobs failed, so show it only when nothing else failed.
  const failed = view.jobs.filter((job) => job.conclusion === "failure");
  const realFailures = failed.filter((job) => job.name !== "Check");
  for (const job of realFailures.length > 0 ? realFailures : failed) {
    const logs = NodeChildProcess.spawnSync(
      "gh",
      ["run", "view", runId, "-R", repo, "--log-failed", "--job", String(job.databaseId)],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ).stdout;
    // Lines read `job<TAB>step<TAB>timestamp text`.
    const lines = logs
      .split("\n")
      .map((line) =>
        line
          .split("\t")
          .slice(1)
          .join(": ")
          .replace(/: \uFEFF?\S+Z /, ": "),
      )
      .slice(-80);
    console.log(`\n--- ${job.name} (last ${lines.length} lines)\n${lines.join("\n")}`);
  }
  console.log(`\ncheck:changed summary\n${summary.join("\n")}`);
  console.log(`check:changed: CI ${view.conclusion === "success" ? "passed" : view.conclusion}`);
  process.exitCode = view.conclusion === "success" ? 0 : 1;
} catch (error) {
  console.error(`check:changed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Run `vp run check:changed --local` to check on this machine.");
  process.exitCode = 1;
} finally {
  cleanUp();
}
