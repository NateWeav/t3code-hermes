// The fork's server and launcher read their home from T3HERMES_HOME and ignore upstream's
// T3CODE_HOME. Upstream release scripts that set or expect T3CODE_HOME merge cleanly, then
// fail only inside a release build. Failing here stops them on the sync PR instead.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const releasePaths = ["scripts", "apps/desktop/scripts", "apps/server/scripts", ".github"];
// Upstream's public installers, which the fork does not publish.
const unshipped = new Set(["scripts/install.sh", "scripts/install.ps1", "scripts/install.test.ts"]);

test("release scripts use the fork's T3HERMES_HOME", () => {
  let matches = "";
  try {
    matches = execFileSync(
      "git",
      ["grep", "-n", "T3CODE_HOME", "--", ...releasePaths, `:!${path.relative(root, __filename)}`],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status !== 1) throw error;
  }
  const shipped = matches
    .split("\n")
    .filter((line) => line !== "" && !unshipped.has(line.slice(0, line.indexOf(":"))));
  assert.deepEqual(shipped, [], "Rename T3CODE_HOME to T3HERMES_HOME in these release scripts.");
});
