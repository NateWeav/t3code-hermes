const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

function verify({ failures = 0, code = "ETARGET", reportedVersion = "t3-hermes v1.2.3" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-npm-release-"));
  try {
    writeFileSync(
      path.join(dir, "npm"),
      `#!/usr/bin/env bash
if [[ "$1" == view ]]; then
  echo 1.2.3
  exit 0
fi
echo exec >> "$TEST_DIR/calls"
count=$(wc -l < "$TEST_DIR/calls")
if (( count <= TEST_FAILURES )); then
  echo "npm error code $TEST_CODE" >&2
  exit 1
fi
echo "$TEST_VERSION"
`,
      { mode: 0o755 },
    );
    // No real waits or registry access: failures advance on each npm call.
    writeFileSync(path.join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const result = spawnSync(
      "bash",
      [path.resolve(__dirname, "../../scripts/verify-npm-release.sh"), "1.2.3", "nightly"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}${path.delimiter}${process.env.PATH}`,
          TEST_DIR: dir,
          TEST_FAILURES: String(failures),
          TEST_CODE: code,
          TEST_VERSION: reportedVersion,
        },
      },
    );
    return {
      ...result,
      calls: readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("verifies an immediately available release", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 1);
});

for (const code of ["ETARGET", "E404"]) {
  test(`retries ${code} after the tag becomes visible`, () => {
    const result = verify({ failures: 2, code });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, 3);
  });
}

test("fails after the bounded propagation window", () => {
  const result = verify({ failures: 20 });
  assert.equal(result.status, 1);
  assert.equal(result.calls, 12);
});

test("does not retry unrelated CLI or install failures", () => {
  const result = verify({ failures: 2, code: "EACCES" });
  assert.equal(result.status, 1);
  assert.equal(result.calls, 1);
});

test("rejects a CLI reporting the wrong version", () => {
  const result = verify({ reportedVersion: "t3-hermes v1.2.2" });
  assert.equal(result.status, 1);
  assert.equal(result.calls, 1);
  assert.match(result.stderr, /expected '1\.2\.3'/);
});
