// A job with a sparse checkout has only the paths its checkout lists. Upstream trims checkouts to
// what its own steps read, and the trim merges cleanly past a fork step that runs another repo
// file, so the release fails after it has published. Failing here stops that on the sync PR.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const workflowsDir = path.join(__dirname, "../workflows");
const git = (args, input) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 1 << 28 });

/** Each sparse-checkout job's rules and the tracked files its steps name. */
function sparseJobs(workflow, tracked) {
  const start = workflow.search(/^jobs:\s*$/m);
  if (start === -1) return [];
  return workflow
    .slice(start)
    .split(/^(?=  [\w-]+:\s*$)/m)
    .slice(1)
    .flatMap((block) => {
      const checkout = block.match(
        /^( +)sparse-checkout:[ \t]*(\|-?)?[ \t]*(.*)\n((?:\1[ \t]+\S.*\n)*)/m,
      );
      if (!checkout) return [];
      const [listed, , isBlock, inline, lines] = checkout;
      const rules = isBlock
        ? lines
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [inline];
      const files = new Set();
      for (const line of block.replace(listed, "").split("\n")) {
        const text = line.trim();
        // Comments and messages name files for people, not for the step to read.
        if (/^(#|echo\b|printf\b)/.test(text)) continue;
        for (const token of text.match(/[\w.@/-]+/g) ?? []) {
          const file = token.replace(/^\.?\//, "");
          if (tracked.has(file)) files.add(file);
          else if (tracked.has(`${file}/action.yml`)) files.add(`${file}/action.yml`);
        }
      }
      return [
        {
          name: block.match(/^  ([\w-]+):/)[1],
          rules,
          cone: !/^ +sparse-checkout-cone-mode:\s*false\s*$/m.test(block),
          files: [...files],
        },
      ];
    });
}

/** The job's named files that git's own sparse rules leave out of the checkout. */
function missing({ rules, cone, files }) {
  if (files.length === 0) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-rules-"));
  try {
    const rulesFile = path.join(dir, "rules");
    fs.writeFileSync(rulesFile, `${rules.join("\n")}\n`);
    const args = ["sparse-checkout", "check-rules", cone ? "--cone" : "--no-cone"];
    const kept = new Set(
      git([...args, "--rules-file", rulesFile], `${files.join("\n")}\n`).split("\n"),
    );
    return files.filter((file) => !kept.has(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("flags files a step names that its sparse checkout leaves out", () => {
  const tracked = new Set([
    "package.json",
    "scripts/kept.ts",
    "scripts/verify.sh",
    "docs/guide.md",
    ".github/actions/setup/action.yml",
    ".github/scripts/a.cjs",
  ]);
  const workflow = `
jobs:
  publish:
    steps:
      - uses: actions/checkout@v6
        with:
          sparse-checkout: |
            /.github/actions/setup/
            /scripts/kept.ts
          sparse-checkout-cone-mode: false
      - uses: ./.github/actions/setup
      # scripts/verify.sh used to run here.
      - run: |
          node scripts/kept.ts
          bash scripts/verify.sh
          echo "see docs/guide.md" >&2
          jq .version package.json
  cone:
    steps:
      - uses: actions/checkout@v6
        with:
          sparse-checkout: .github/scripts
      - run: node ./.github/scripts/a.cjs package.json
  full:
    steps:
      - uses: actions/checkout@v6
      - run: bash scripts/verify.sh
`;
  assert.deepEqual(
    sparseJobs(workflow, tracked).map((job) => [job.name, job.files, missing(job)]),
    [
      [
        "publish",
        [
          ".github/actions/setup/action.yml",
          "scripts/kept.ts",
          "scripts/verify.sh",
          "package.json",
        ],
        ["scripts/verify.sh", "package.json"],
      ],
      // Cone mode always keeps the root's files.
      ["cone", [".github/scripts/a.cjs", "package.json"], []],
    ],
  );
});

test("every repo file a sparse-checkout job names is in its checkout", () => {
  const tracked = new Set(
    git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean),
  );
  const jobs = fs
    .readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      sparseJobs(fs.readFileSync(path.join(workflowsDir, file), "utf8"), tracked).map((job) => ({
        ...job,
        name: `${file} ${job.name}`,
      })),
    );
  assert.ok(
    jobs.filter((job) => job.files.length > 0).length > 10,
    `expected sparse-checkout jobs that name repo files, found ${jobs.map((job) => job.name)}`,
  );
  assert.deepEqual(
    jobs.flatMap((job) => missing(job).map((file) => `${job.name}: ${file}`)),
    [],
    "Add these files to the job's sparse-checkout list.",
  );
});
