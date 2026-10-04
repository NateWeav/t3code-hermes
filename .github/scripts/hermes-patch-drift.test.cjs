const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WHOLE_FILE,
  decide,
  fileResult,
  formatReport,
  newFailures,
  ownersOfTestFile,
  parsePytestFailures,
  patchTestFiles,
} = require("./hermes-patch-drift.cjs");

const SHA = "5a8dea85fbb636ae09adafa2272d511ae1e227a3";

const patch = (id, overrides = {}) => ({
  id,
  file: `${id}/5a8dea85fbb6.patch`,
  apply: true,
  reverse: false,
  stack: true,
  onMain: true,
  behind: 12,
  testFiles: [],
  ...overrides,
});

test("patch test files come from the b/ side of test diffs only", () => {
  const text = [
    "diff --git a/acp_adapter/events.py b/acp_adapter/events.py",
    "--- a/acp_adapter/events.py",
    "diff --git a/tests/acp_adapter/test_tools.py b/tests/acp_adapter/test_tools.py",
    "diff --git a/tests/conftest.py b/tests/conftest.py",
    "diff --git a/tests/gateway/test_x.py b/tests/gateway/test_x.py",
    "diff --git a/tests/gateway/test_x.py b/tests/gateway/test_x.py",
    "+diff --git a/tests/fake/test_y.py b/tests/fake/test_y.py inside a hunk",
  ].join("\n");
  assert.deepEqual(patchTestFiles(text), [
    "tests/acp_adapter/test_tools.py",
    "tests/gateway/test_x.py",
  ]);
});

test("pytest -rfE summary lines yield failed and errored node ids", () => {
  const output = [
    "..F.E",
    "FAILED tests/a/test_x.py::test_one - AssertionError: nope",
    "ERROR tests/a/test_x.py::test_two",
    "FAILED tests/a/test_x.py::TestK::test_p[a-b] - boom",
    "FAILED tests/a/test_x.py::test_s[param with space] - assert x[0] == 1",
    "ERROR tests/a/test_x.py::test_d[a - b]",
    "1 failed, 3 passed",
  ].join("\n");
  assert.deepEqual(parsePytestFailures(output), [
    "tests/a/test_x.py::TestK::test_p[a-b]",
    "tests/a/test_x.py::test_d[a - b]",
    "tests/a/test_x.py::test_one",
    "tests/a/test_x.py::test_s[param with space]",
    "tests/a/test_x.py::test_two",
  ]);
});

test("exit codes map to passed, failed tests, or a crashed file", () => {
  assert.deepEqual(fileResult({ status: 0, output: "" }).failures, []);
  assert.equal(fileResult({ status: 5, output: "no tests ran" }).crashed, false);
  assert.deepEqual(fileResult({ status: 1, output: "FAILED t.py::a - x" }).failures, ["t.py::a"]);
  assert.equal(fileResult({ status: 1, output: "1 failed" }).crashed, true);
  assert.equal(fileResult({ status: 2, output: "collection error" }).crashed, true);
  assert.equal(fileResult({ status: null, output: "" }).crashed, true);
  assert.equal(fileResult({ missing: true }).missing, true);
});

test("only failures absent from the baseline count, and flakes drop out on rerun", () => {
  const ok = { missing: false, crashed: false, failures: [] };
  const fails = (...ids) => ({ missing: false, crashed: false, failures: ids });
  const crashed = { missing: false, crashed: true, failures: [] };
  const missing = { missing: true, crashed: false, failures: [] };

  assert.deepEqual(newFailures(fails("a"), fails("a")), []);
  assert.deepEqual(newFailures(fails("a"), fails("a", "b")), ["b"]);
  assert.deepEqual(newFailures(ok, crashed), [WHOLE_FILE]);
  assert.deepEqual(newFailures(crashed, fails("a")), []);
  // A test file the patch adds has no baseline.
  assert.deepEqual(newFailures(missing, fails("n")), ["n"]);
  assert.deepEqual(newFailures(ok, fails("b", "c"), fails("c")), ["c"]);
  assert.deepEqual(newFailures(ok, fails("b"), ok), []);
  assert.deepEqual(newFailures(ok, fails("b"), crashed), ["b"]);
  assert.deepEqual(newFailures(ok, crashed, fails("b")), ["b"]);
  assert.deepEqual(newFailures(ok, crashed, crashed), [WHOLE_FILE]);
  assert.deepEqual(newFailures(ok, crashed, ok), []);
});

test("failing test files are charged to the patches that own them", () => {
  const patches = [
    patch("ssh", { testFiles: ["tests/tools/test_ssh.py", "tests/acp_adapter/test_session.py"] }),
    patch("bg", { testFiles: ["tests/acp_adapter/test_background.py"] }),
    patch("hook", { testFiles: ["tests/gateway/test_webhook_session_close.py"] }),
  ];
  assert.deepEqual(ownersOfTestFile("tests/tools/test_ssh.py", patches), ["ssh"]);
  assert.deepEqual(ownersOfTestFile("tests/acp_adapter/test_tools.py", patches), ["ssh", "bg"]);
  assert.deepEqual(ownersOfTestFile("tests/cli/test_other.py", patches), ["ssh", "bg", "hook"]);
});

test("statuses: obsolete beats doesNotApply beats stackConflict beats testsFailed", () => {
  const results = decide({
    hermesSha: SHA,
    testFiles: [],
    tests: null,
    patches: [
      patch("gone", { apply: false, reverse: true, stack: null }),
      patch("broken", { apply: false, stack: null }),
      patch("clash", { stack: false }),
      patch("fine"),
    ],
  });
  assert.deepEqual(
    results.map((result) => result.status),
    ["obsolete", "doesNotApply", "stackConflict", "ok"],
  );
});

test("testsFailed lists the new failing files per patch", () => {
  const ok = { missing: false, crashed: false, failures: [] };
  const fails = (...ids) => ({ missing: false, crashed: false, failures: ids });
  const results = decide({
    hermesSha: SHA,
    testFiles: ["tests/tools/test_ssh.py", "tests/acp_adapter/test_session.py"],
    tests: {
      baseline: {
        "tests/tools/test_ssh.py": ok,
        "tests/acp_adapter/test_session.py": fails("s::old"),
      },
      patched: {
        "tests/tools/test_ssh.py": fails("x::y"),
        "tests/acp_adapter/test_session.py": fails("s::old"),
      },
      rerun: { "tests/tools/test_ssh.py": fails("x::y") },
    },
    patches: [
      patch("ssh", { testFiles: ["tests/tools/test_ssh.py"] }),
      patch("bg", { testFiles: ["tests/acp_adapter/test_bg.py"] }),
    ],
  });
  assert.deepEqual(
    results.map(({ id, status, failingTests }) => ({ id, status, failingTests })),
    [
      { id: "ssh", status: "testsFailed", failingTests: ["tests/tools/test_ssh.py"] },
      { id: "bg", status: "ok", failingTests: [] },
    ],
  );
});

test("the report carries the parseable Hermes SHA and status lines", () => {
  const body = formatReport({
    hermesSha: SHA,
    runUrl: "https://github.com/NateWeav/t3code-hermes/actions/runs/42",
    results: [
      {
        id: "acp-background-reports",
        file: "acp-background-reports/5a8dea85fbb6.patch",
        status: "testsFailed",
        onMain: true,
        behind: 7,
        failingTests: ["tests/acp_adapter/test_background_reports.py"],
      },
      {
        id: "acp-central-ssh-execution",
        file: "acp-central-ssh-execution/0123456789ab.patch",
        status: "doesNotApply",
        onMain: false,
        behind: null,
        failingTests: [],
      },
    ],
  });
  assert.match(body, new RegExp(`^Hermes main: \`${SHA}\`$`, "m"));
  assert.match(body, /^- `acp-background-reports`: `testsFailed` \(.*7 commits behind main\)$/m);
  assert.match(body, /^ {2}- `tests\/acp_adapter\/test_background_reports\.py`$/m);
  assert.match(body, /^- `acp-central-ssh-execution`: `doesNotApply` \(.*not on main\)$/m);
  assert.match(
    body,
    /\[Run log\]\(https:\/\/github\.com\/NateWeav\/t3code-hermes\/actions\/runs\/42\)/,
  );
});
