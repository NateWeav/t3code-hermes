// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the deployment shell against disposable filesystem fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { githubRepository, selectNightlyTag } from "../infra/hyperion/resolve-nightly.ts";

const updater = NodeURL.fileURLToPath(
  new URL("../infra/hyperion/t3code-update.sh", import.meta.url),
);
const temporaryDirectories: string[] = [];
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hyperion-update-test-"));
  temporaryDirectories.push(root);
  NodeFS.mkdirSync(NodePath.join(root, "state"));
  NodeFS.mkdirSync(NodePath.join(root, "apps/server"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "apps/web"), { recursive: true });
  return root;
}
function shell(root: string, command: string) {
  return NodeChildProcess.spawnSync("bash", ["-c", 'source "$UPDATER"; ' + command], {
    encoding: "utf8",
    env: {
      ...process.env,
      UPDATER: updater,
      T3CODE_UPDATE_CONFIG: "/dev/null",
      T3CODE_DIR: root,
      T3CODE_STATE_DIR: NodePath.join(root, "state"),
      T3CODE_UPDATE_SELF_COPY: "",
      APP_VERSION: "0.0.41-nightly.20260909.72",
    },
  });
}
afterEach(() => {
  for (const root of temporaryDirectories.splice(0))
    NodeFS.rmSync(root, { recursive: true, force: true });
});

const release = (tag: string, date: string, extra = {}) => ({
  tag_name: tag,
  published_at: date,
  draft: false,
  prerelease: true,
  ...extra,
});
describe("published nightly selection", () => {
  it("chooses by publication time, excluding stable and draft releases", () => {
    expect(
      selectNightlyTag([
        release("v0.0.41-nightly.20260909.72", "2026-09-09T12:00:00Z"),
        release("v0.0.41-nightly.20260908.71", "2026-09-08T12:00:00Z"),
        release("v0.0.42", "2026-09-10T12:00:00Z", { prerelease: false }),
        release("v0.0.41-nightly.20260910.73", "2026-09-10T12:00:00Z", { draft: true }),
        null,
      ]),
    ).toBe("v0.0.41-nightly.20260909.72");
  });
  it("rejects missing or malformed release data", () => {
    expect(() => selectNightlyTag({ message: "rate limited" })).toThrow("release list");
    expect(() => selectNightlyTag([release("v0.0.41-nightly.20260909.72", "invalid"), {}])).toThrow(
      "No published nightly",
    );
  });
  it("supports HTTPS and SSH GitHub remotes", () => {
    expect(githubRepository("https://github.com/NateWeav/t3code-hermes.git")).toBe(
      "NateWeav/t3code-hermes",
    );
    expect(githubRepository("git@github.com:NateWeav/t3code-hermes.git")).toBe(
      "NateWeav/t3code-hermes",
    );
    expect(() => githubRepository("https://example.com/a/b.git")).toThrow("GitHub");
  });
});

describe("nightly artifact recovery", () => {
  it.each([true, false])("restores previous artifacts with previous web assets = %s", (hasWeb) => {
    const root = fixture();
    NodeFS.mkdirSync(NodePath.join(root, "apps/server/dist"));
    NodeFS.writeFileSync(NodePath.join(root, "apps/server/dist/bin.mjs"), "previous server");
    if (hasWeb) {
      NodeFS.mkdirSync(NodePath.join(root, "apps/web/dist"));
      NodeFS.writeFileSync(NodePath.join(root, "apps/web/dist/index.html"), "previous web");
    }
    const result = shell(
      root,
      'stash_dist; mkdir -p "$SERVER_DIST" "$WEB_DIST"; echo broken > "$SERVER_DIST/bin.mjs"; echo broken > "$WEB_DIST/index.html"; restore_dist',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(root, "apps/server/dist/bin.mjs"), "utf8")).toBe(
      "previous server",
    );
    expect(NodeFS.existsSync(NodePath.join(root, "apps/web/dist/index.html"))).toBe(hasWeb);
    if (hasWeb)
      expect(NodeFS.readFileSync(NodePath.join(root, "apps/web/dist/index.html"), "utf8")).toBe(
        "previous web",
      );
  });
  it.each([true, false])(
    "rebuilds after an empty backup with partial web assets = %s",
    (partialWeb) => {
      const root = fixture();
      NodeFS.writeFileSync(NodePath.join(root, "apps/server/package.json"), '{"version":"0.0.40"}');
      const result = shell(
        root,
        `stash_dist;
      ${partialWeb ? 'mkdir -p "$WEB_DIST"; echo partial > "$WEB_DIST/index.html";' : ""}
      build_release() { [[ ! -e "$WEB_DIST/index.html" ]] || exit 98; echo "$APP_VERSION" > "$T3CODE_DIR/rebuilt"; };
      restore_web_assets_for_rollback`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(NodeFS.readFileSync(NodePath.join(root, "rebuilt"), "utf8")).toBe("0.0.40\n");
    },
  );
  it("builds a versioned bundle with its client and restores the manifest", () => {
    const root = fixture();
    const manifest = '{"name":"t3-hermes","version":"0.0.0"}\n';
    NodeFS.writeFileSync(NodePath.join(root, "apps/server/package.json"), manifest);
    const result = shell(
      root,
      `pnpm() {
      if [[ "$*" == *build:bundle* ]]; then
        mkdir -p apps/server/dist
        printf 'console.log("t3-hermes v%s");' "$APP_VERSION" > apps/server/dist/bin.mjs
      else
        mkdir -p apps/web/dist
        echo client > apps/web/dist/index.html
      fi
    }; if build_release; then exit 0; else exit $?; fi`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8")).toBe(
      manifest,
    );
    expect(
      NodeFS.readFileSync(NodePath.join(root, "apps/server/dist/.nightly-version"), "utf8").trim(),
    ).toBe("0.0.41-nightly.20260909.72");
    expect(
      NodeFS.readFileSync(NodePath.join(root, "apps/server/dist/client/index.html"), "utf8"),
    ).toBe("client\n");
    const noop = shell(
      root,
      `preflight() { :; }; acquire_lock() { :; }; resolve_nightly() { :; };
      ensure_checkout() { :; }; resolve_health_target() { :; }; fetch_origin() { :; };
      git_repo() { echo same-commit; }; stop_service() { exit 99; }; main`,
    );
    expect(noop.status, noop.stderr).toBe(0);
  });
  it("propagates bundle failures and restores the tracked manifest", () => {
    const root = fixture();
    const manifest = '{"name":"t3-hermes","version":"0.0.0"}\n';
    NodeFS.writeFileSync(NodePath.join(root, "apps/server/package.json"), manifest);
    const result = shell(
      root,
      'pnpm() { if [[ "$*" == *build:bundle* ]]; then return 42; fi; }; if build_release; then exit 0; else exit $?; fi',
    );
    expect(result.status, result.stderr).toBe(42);
    expect(NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8")).toBe(
      manifest,
    );
  });
  it("refuses tracked edits before deployment", () => {
    const root = fixture();
    NodeChildProcess.execFileSync("git", ["init", "-q", root]);
    NodeFS.writeFileSync(NodePath.join(root, "tracked"), "original");
    NodeChildProcess.execFileSync("git", ["-C", root, "add", "tracked"]);
    const result = shell(root, "assert_clean_worktree");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("commit/stash");
  });
});
