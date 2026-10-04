// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { HERMES_PATCH_FILES } from "./hermesPatchFiles.generated.ts";
import {
  changeHermesPatch,
  HERMES_PATCHES,
  isHermesCheckoutDetached,
  readHermesPatches,
  resolveHermesGitCheckout,
  type HermesPatchDefinition,
  type HermesPatchVersion,
} from "./hermesPatches.ts";

const INFRA_HERMES = NodePath.resolve(import.meta.dirname, "../../../../infra/hermes");

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const commit = (root: string, message: string) => {
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
};

/** The diff that rewrites `file` to `content` at the current HEAD, leaving the tree clean. */
const diffAt = (root: string, file: string, content: string, hermesCommit: string) => {
  const path = NodePath.join(root, file);
  const original = NodeFS.readFileSync(path, "utf8");
  NodeFS.writeFileSync(path, content);
  const version: HermesPatchVersion = {
    hermesCommit,
    hermesCommitDate: "2026-10-01T00:00:00Z",
    content: git(root, "diff"),
  };
  NodeFS.writeFileSync(path, original);
  return version;
};

const definition = (versions: ReadonlyArray<HermesPatchVersion>): HermesPatchDefinition => ({
  id: HermesPatchId.make("test-patch"),
  title: "Test",
  neededFor: "Tests.",
  versions,
});

/** A one-file repo on `main`, plus a patch that rewrites that file. */
const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
  git(root, "init", "--quiet");
  NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = None\n");
  const base = commit(root, "base");
  const patch = definition([diffAt(root, "session.py", "remote_cwd = configured()\n", base)]);
  return { root, patch };
});

/**
 * A repo with two Hermes commits that each need their own version of one
 * patch: upstream rewrote the line next to the patched one in between.
 */
const makeTwoVersionCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
  git(root, "init", "--quiet");
  const file = NodePath.join(root, "session.py");
  NodeFS.writeFileSync(file, "backend = local\nremote_cwd = None\n");
  const older = commit(root, "older");
  const olderVersion = diffAt(
    root,
    "session.py",
    "backend = local\nremote_cwd = configured()\n",
    older,
  );
  NodeFS.writeFileSync(file, "backend = resolve()\nremote_cwd = None\n");
  const newer = commit(root, "newer");
  const newerVersion = diffAt(
    root,
    "session.py",
    "backend = resolve()\nremote_cwd = configured()\n",
    newer,
  );
  return { root, file, older, newer, patch: definition([newerVersion, olderVersion]) };
});

const stateOf = (root: string, patch: HermesPatchDefinition) =>
  readHermesPatches(root, [patch]).pipe(Effect.map(([status]) => status?.state));

describe("hermes patches", () => {
  it("embeds every infra/hermes patch version the manifest lists, byte for byte", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(INFRA_HERMES, "patches.json"), "utf8"),
    ) as {
      patches: ReadonlyArray<{
        id: string;
        title: string;
        neededFor: string;
        versions: ReadonlyArray<{ hermesCommit: string; hermesCommitDate: string; file: string }>;
      }>;
    };
    const expected = manifest.patches.map((patch) => ({
      ...patch,
      versions: patch.versions.map((version) => ({
        ...version,
        content: NodeFS.readFileSync(NodePath.join(INFRA_HERMES, version.file), "utf8"),
      })),
    }));
    // Regenerate with `node scripts/generate-hermes-patches.ts`.
    assert.deepStrictEqual(HERMES_PATCH_FILES, expected);
    // A version saved under infra/hermes but left out of the manifest would
    // otherwise never ship, and nothing else in CI would say so.
    const onDisk = NodeFS.readdirSync(INFRA_HERMES, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".patch"))
      .map((file) => file.split(NodePath.sep).join("/"))
      .sort();
    assert.deepStrictEqual(
      onDisk,
      manifest.patches.flatMap((patch) => patch.versions.map((version) => version.file)).sort(),
    );
    assert.deepStrictEqual(
      HERMES_PATCHES.map((patch) => patch.id),
      manifest.patches.map((patch) => patch.id),
    );
  });

  it.effect("reads, applies, and removes a patch", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;

      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies the version made for the checkout's Hermes, older or newer", () =>
    Effect.gen(function* () {
      const { root, file, older, patch } = yield* makeTwoVersionCheckout;

      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(
        NodeFS.readFileSync(file, "utf8"),
        "backend = resolve()\nremote_cwd = configured()\n",
      );
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);

      git(root, "checkout", "--quiet", older);
      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(
        NodeFS.readFileSync(file, "utf8"),
        "backend = local\nremote_cwd = configured()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads an applied older version as applied, and removes that version", () =>
    Effect.gen(function* () {
      const { root, file, older, patch } = yield* makeTwoVersionCheckout;
      git(root, "checkout", "--quiet", older);
      NodeFS.writeFileSync(file, "backend = local\nremote_cwd = configured()\n");

      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "backend = local\nremote_cwd = None\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the version applied when two versions patch to the same text", () =>
    Effect.gen(function* () {
      // Upstream rewrote the very line the patch replaces, so both versions
      // produce the same file and both reverse cleanly on either commit.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = None\nb = 2\n");
      const older = commit(root, "older");
      const olderVersion = diffAt(
        root,
        "session.py",
        "a = 1\nremote_cwd = configured()\nb = 2\n",
        older,
      );
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = default()\nb = 2\n");
      const newer = commit(root, "newer");
      const newerVersion = diffAt(
        root,
        "session.py",
        "a = 1\nremote_cwd = configured()\nb = 2\n",
        newer,
      );
      const patch = definition([newerVersion, olderVersion]);

      git(root, "checkout", "--quiet", older);
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "a = 1\nremote_cwd = None\nb = 2\n");
      assert.strictEqual(git(root, "status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the version applied when two fit HEAD at different places", () =>
    Effect.gen(function* () {
      // One block, three times over. The older version sets the first `v` to
      // 2, the newer one the second: once the older is applied both reverse
      // cleanly, and both apply to HEAD. Reversing the newer would turn the
      // first `v` into the second's original 3.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const olderVersion = diffAt(root, "session.py", lines("2", "3"), base);
      const newerVersion = diffAt(root, "session.py", lines("1", "2"), base);
      const patch = definition([newerVersion, olderVersion]);

      NodeFS.writeFileSync(file, lines("2", "3"));
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the applied version beside another patch in the same file", () =>
    Effect.gen(function* () {
      // As above, with a second patch applied further down the same file.
      // Its change is in the checkout but in no candidate's scratch tree, so
      // only once it is taken back out does the applied version match.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const padding = "p = 0\np = 1\np = 2\np = 3\n";
      const lines = (first: string, second: string, tail = "0") =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}${padding}tail = ${tail}\n`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const olderVersion = diffAt(root, "session.py", lines("2", "3"), base);
      const newerVersion = diffAt(root, "session.py", lines("1", "2"), base);
      const patch = definition([newerVersion, olderVersion]);
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other-patch"),
        title: "Other",
        neededFor: "Tests.",
        versions: [diffAt(root, "session.py", lines("1", "3", "1"), base)],
      };

      NodeFS.writeFileSync(file, lines("2", "3", "1"));
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse", [patch, other])).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3", "1"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes every file of the applied version when another touches fewer", () =>
    Effect.gen(function* () {
      // The older version changes two files, the newer only one of them the
      // same way: once the older is applied, both reverse cleanly.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const session = NodePath.join(root, "session.py");
      const config = NodePath.join(root, "config.py");
      NodeFS.writeFileSync(session, "remote_cwd = None\n");
      NodeFS.writeFileSync(config, "ssh = False\n");
      const base = commit(root, "base");
      NodeFS.writeFileSync(config, "ssh = True\n");
      const olderVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      NodeFS.writeFileSync(config, "ssh = False\n");
      const newerVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      const patch = definition([newerVersion, olderVersion]);

      NodeFS.writeFileSync(session, "remote_cwd = configured()\n");
      NodeFS.writeFileSync(config, "ssh = True\n");
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(git(root, "status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("applies the version made for this checkout when an older one also fits", () =>
    Effect.gen(function* () {
      // Both versions apply to the older commit, at different `v`s; only the
      // older one was made for it.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const older = commit(root, "older");
      const olderVersion = diffAt(root, "session.py", lines("2", "3"), older);
      NodeFS.writeFileSync(NodePath.join(root, "notes.txt"), "newer\n");
      const newer = commit(root, "newer");
      const newerVersion = diffAt(root, "session.py", lines("1", "2"), newer);
      const patch = definition([newerVersion, olderVersion]);

      git(root, "checkout", "--quiet", older);
      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("2", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to guess which version to apply when nothing tells them apart", () =>
    Effect.gen(function* () {
      // Neither version's commit is in this history, and they change
      // different lines.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      const block = "k = 0\nk = 1\nk = 2\n";
      const lines = (first: string, second: string) =>
        `${block}v = ${first}\n${block}v = ${second}\n${block}`;
      NodeFS.writeFileSync(file, lines("1", "3"));
      const base = commit(root, "base");
      const unknown = (version: HermesPatchVersion): HermesPatchVersion => ({
        ...version,
        hermesCommit: "0123456789abcdef0123456789abcdef01234567",
      });
      const patch = definition([
        unknown(diffAt(root, "session.py", lines("1", "2"), base)),
        unknown(diffAt(root, "session.py", lines("2", "3"), base)),
      ]);

      assert.strictEqual(yield* stateOf(root, patch), "notApplied");
      assert.isFalse((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), lines("1", "3"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the renamed file of the applied version", () =>
    Effect.gen(function* () {
      // Each version renames a different file to the same name, with the same
      // content: only the source path tells them apart.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      NodeFS.writeFileSync(NodePath.join(root, "old_a.py"), "same = 1\n");
      NodeFS.writeFileSync(NodePath.join(root, "old_b.py"), "same = 1\n");
      const base = commit(root, "base");
      const renameVersion = (from: string): HermesPatchVersion => {
        git(root, "mv", from, "session.py");
        const content = git(root, "diff", "--cached", "-M", "HEAD");
        git(root, "reset", "--quiet", "--hard", base);
        return { hermesCommit: base, hermesCommitDate: "2026-10-01T00:00:00Z", content };
      };
      const newerVersion = renameVersion("old_b.py");
      const olderVersion = renameVersion("old_a.py");
      const patch = definition([newerVersion, olderVersion]);

      git(root, "mv", "old_a.py", "session.py");
      git(root, "reset", "--quiet");
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "old_a.py")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "session.py")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes a file the applied version added", () =>
    Effect.gen(function* () {
      // The older version also adds a file, which `git apply` leaves
      // untracked; the newer changes only the tracked one, the same way.
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const session = NodePath.join(root, "session.py");
      const added = NodePath.join(root, "helper.py");
      NodeFS.writeFileSync(session, "remote_cwd = None\n");
      const base = commit(root, "base");
      const newerVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      NodeFS.writeFileSync(added, "def helper(): pass\n");
      git(root, "add", "--intent-to-add", "helper.py");
      const olderVersion = diffAt(root, "session.py", "remote_cwd = configured()\n", base);
      git(root, "rm", "--quiet", "--cached", "helper.py");
      NodeFS.rmSync(added);
      const patch = definition([newerVersion, olderVersion]);

      NodeFS.writeFileSync(NodePath.join(root, "older.patch"), olderVersion.content);
      git(root, "apply", "older.patch");
      NodeFS.rmSync(NodePath.join(root, "older.patch"));
      assert.isTrue(NodeFS.existsSync(added));
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isTrue((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.isFalse(NodeFS.existsSync(added));
      assert.strictEqual(git(root, "status", "--porcelain"), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not remove a change upstream now carries", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      const file = NodePath.join(root, "session.py");
      NodeFS.writeFileSync(file, "remote_cwd = configured()\n");
      commit(root, "upstream carries it");

      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "remote_cwd = configured()\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to guess which version to remove once it is committed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-checkout-" });
      git(root, "init", "--quiet");
      const file = NodePath.join(root, "session.py");
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = None\nb = 2\n");
      const older = commit(root, "older");
      const patched = "a = 1\nremote_cwd = configured()\nb = 2\n";
      const olderVersion = diffAt(root, "session.py", patched, older);
      NodeFS.writeFileSync(file, "a = 1\nremote_cwd = default()\nb = 2\n");
      const newer = commit(root, "newer");
      const patch = definition([diffAt(root, "session.py", patched, newer), olderVersion]);

      git(root, "checkout", "--quiet", older);
      NodeFS.writeFileSync(file, patched);
      commit(root, "patched by hand");
      assert.strictEqual(yield* stateOf(root, patch), "applied");
      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), patched);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a checkout no version fits as not applying, and leaves it alone", () =>
    Effect.gen(function* () {
      const { root, file, patch } = yield* makeTwoVersionCheckout;
      NodeFS.writeFileSync(file, "backend = remote()\nremote_cwd = rewritten()\n");

      assert.strictEqual(yield* stateOf(root, patch), "doesNotApply");
      assert.isFalse((yield* changeHermesPatch(root, patch, "forward")).ok);
      assert.isFalse((yield* changeHermesPatch(root, patch, "reverse")).ok);
      assert.strictEqual(
        NodeFS.readFileSync(file, "utf8"),
        "backend = remote()\nremote_cwd = rewritten()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a patch the checkout has drifted away from as not applying", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      NodeFS.writeFileSync(NodePath.join(root, "session.py"), "remote_cwd = rewritten()\n");

      assert.strictEqual(yield* stateOf(root, patch), "doesNotApply");
      const refused = yield* changeHermesPatch(root, patch, "forward");
      assert.isFalse(refused.ok);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(root, "session.py"), "utf8"),
        "remote_cwd = rewritten()\n",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the Hermes checkout even when git bindings point elsewhere", () =>
    Effect.gen(function* () {
      const { root, patch } = yield* makeCheckout;
      const decoy = yield* makeCheckout;
      git(decoy.root, "checkout", "--quiet", "--detach");
      const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
      process.env.GIT_DIR = NodePath.join(decoy.root, ".git");
      process.env.GIT_WORK_TREE = decoy.root;
      const restore = Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });

      const detached = yield* isHermesCheckoutDetached(root).pipe(Effect.ensuring(restore));
      assert.isFalse(detached);
      const [status] = yield* readHermesPatches(root, [patch]);
      assert.strictEqual(status?.state, "notApplied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("notices a detached HEAD, which hermes update cannot move", () =>
    Effect.gen(function* () {
      const { root } = yield* makeCheckout;
      assert.isFalse(yield* isHermesCheckoutDetached(root));
      git(root, "checkout", "--quiet", "--detach");
      assert.isTrue(yield* isHermesCheckoutDetached(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds the checkout only for a venv binary beside a .git", () =>
    Effect.gen(function* () {
      const { root } = yield* makeCheckout;
      const binary = NodePath.join(root, "venv", "bin", "hermes");
      assert.strictEqual(yield* resolveHermesGitCheckout(binary), root);
      assert.isNull(yield* resolveHermesGitCheckout("/usr/bin/hermes"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
