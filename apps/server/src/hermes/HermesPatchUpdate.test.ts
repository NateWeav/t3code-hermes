// @effect-diagnostics nodeBuiltinImport:off - builds fixture git repos synchronously.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HermesPatchId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { type HermesPatchDefinition, type HermesPatchVersion } from "./hermesPatches.ts";
import { HermesPatchService, makeWith } from "./HermesPatchService.ts";

const IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t"];

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const commit = (root: string, message: string, date: string) => {
  git(root, "add", ".");
  NodeChildProcess.execFileSync("git", [...IDENTITY, "commit", "--quiet", "-m", message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(root, "rev-parse", "HEAD").trim();
};

/** The diff that rewrites `file` to `content` at the current HEAD, leaving the tree clean. */
const versionAt = (
  root: string,
  file: string,
  content: string,
  hermesCommit: string,
  date: string,
) => {
  const path = NodePath.join(root, file);
  const original = NodeFS.readFileSync(path, "utf8");
  NodeFS.writeFileSync(path, content);
  const version: HermesPatchVersion = {
    hermesCommit,
    hermesCommitDate: date,
    content: git(root, "diff"),
  };
  NodeFS.writeFileSync(path, original);
  return version;
};

const OLDER_DATE = "2026-09-01T00:00:00Z";
const NEWER_DATE = "2026-09-15T00:00:00Z";
const NEWEST_DATE = "2026-09-30T00:00:00Z";

/**
 * A Hermes stand-in: an upstream bare repo with two commits (upstream rewrote
 * the line next to the patched one in between), and a checkout cloned from it
 * sitting at the older commit. Its `venv/bin/hermes` handles `update` with a
 * `git pull --ff-only`, as `hermes update` would. `newerVersion` is the patch
 * version made for the newer commit, `olderVersion` the one for the older.
 */
const makeHermes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hermes-update-" });
  const seed = NodePath.join(base, "seed");
  const upstream = NodePath.join(base, "upstream.git");
  const root = NodePath.join(base, "hermes-agent");
  NodeFS.mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  NodeFS.writeFileSync(NodePath.join(seed, ".gitignore"), "venv/\n");
  NodeFS.writeFileSync(NodePath.join(seed, "session.py"), "backend = local\nremote_cwd = None\n");
  NodeFS.writeFileSync(NodePath.join(seed, "notes.txt"), "notes\n");
  const older = commit(seed, "older", OLDER_DATE);
  const olderVersion = versionAt(
    seed,
    "session.py",
    "backend = local\nremote_cwd = configured()\n",
    older,
    OLDER_DATE,
  );
  NodeFS.writeFileSync(
    NodePath.join(seed, "session.py"),
    "backend = resolve()\nremote_cwd = None\n",
  );
  const newer = commit(seed, "newer", NEWER_DATE);
  const newerVersion = versionAt(
    seed,
    "session.py",
    "backend = resolve()\nremote_cwd = configured()\n",
    newer,
    NEWER_DATE,
  );
  git(base, "clone", "--quiet", "--bare", seed, upstream);
  git(base, "clone", "--quiet", upstream, root);
  git(root, "reset", "--quiet", "--hard", older);

  const binaryPath = NodePath.join(root, "venv", "bin", "hermes");
  NodeFS.mkdirSync(NodePath.dirname(binaryPath), { recursive: true });
  const log = NodePath.join(base, "hermes.log");
  NodeFS.writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      `echo "$@" >> "${log}"`,
      `if [ -f "${NodePath.join(base, "fail")}" ]; then echo "network unreachable" >&2; exit 1; fi`,
      `cd "${root}" && git pull --quiet --ff-only`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const patch = (versions: ReadonlyArray<HermesPatchVersion>): HermesPatchDefinition => ({
    id: HermesPatchId.make("remote-cwd"),
    title: "Remote cwd",
    neededFor: "Tests.",
    versions,
  });
  return {
    base,
    seed,
    upstream,
    root,
    binaryPath,
    log,
    older,
    newer,
    olderVersion,
    newerVersion,
    patch,
    read: () => NodeFS.readFileSync(NodePath.join(root, "session.py"), "utf8"),
    head: () => git(root, "rev-parse", "HEAD").trim(),
    /** Pushes a third upstream commit that rewrites the patched line itself. */
    pushNewest: () => {
      git(seed, "reset", "--quiet", "--hard", newer);
      NodeFS.writeFileSync(
        NodePath.join(seed, "session.py"),
        "backend = resolve()\nremote_cwd = from_profile()\n",
      );
      commit(seed, "newest", NEWEST_DATE);
      git(seed, "push", "--quiet", upstream, "main");
    },
  };
});

const withService = (binaryPath: string, patches: ReadonlyArray<HermesPatchDefinition>) =>
  Effect.provide(
    Layer.effect(HermesPatchService, makeWith({ patches })).pipe(
      Layer.provide(
        ServerSettings.layerTest({ providers: { hermes: { enabled: true, binaryPath } } }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const stateOf = (service: HermesPatchService["Service"]) =>
  service.list.pipe(Effect.map((snapshot) => snapshot.patches[0]));

describe("HermesPatchService.updateHermes", () => {
  it.effect("removes the patch, updates Hermes, and reapplies the version for the new HEAD", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");

        const before = yield* service.list;
        assert.isTrue(before.canUpdateHermes);
        assert.strictEqual(
          before.headCommit,
          git(hermes.root, "rev-parse", "--short", "HEAD").trim(),
        );

        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.deepStrictEqual(result.awaitingPatchUpdate, []);
        assert.strictEqual(hermes.head(), hermes.newer);
        assert.strictEqual(hermes.read(), "backend = resolve()\nremote_cwd = configured()\n");
        assert.strictEqual(result.snapshot.patches[0]?.state, "applied");
        assert.notStrictEqual(result.previousHeadCommit, result.snapshot.headCommit);
        assert.strictEqual(
          NodeFS.readFileSync(hermes.log, "utf8").trim(),
          "update --yes --keep-stash --no-gateway-restart",
        );
        // Nothing parked: the patch was off the tree while Hermes updated.
        assert.strictEqual(git(hermes.root, "stash", "list"), "");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a patch no version fits after the update as awaiting a T3 Code update", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      hermes.pushNewest();
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });

        const result = yield* service.updateHermes;
        assert.isFalse(result.updateFailed);
        assert.deepStrictEqual(result.reapplied, []);
        assert.deepStrictEqual(result.awaitingPatchUpdate, [patch.id]);
        assert.strictEqual(hermes.read(), "backend = resolve()\nremote_cwd = from_profile()\n");
        assert.strictEqual(result.snapshot.patches[0]?.state, "doesNotApply");
        assert.strictEqual(result.snapshot.patches[0]?.reason, "awaitingPatchUpdate");
        assert.strictEqual(git(hermes.root, "status", "--porcelain"), "");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while the checkout has edits of the user's own, and changes nothing", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        NodeFS.writeFileSync(NodePath.join(hermes.root, "notes.txt"), "my notes\n");

        const error = yield* Effect.flip(service.updateHermes);
        assert.strictEqual(error.reason, "wrongState");
        assert.include(error.detail, "notes.txt");
        assert.isFalse(NodeFS.existsSync(hermes.log));
        assert.strictEqual(hermes.head(), hermes.older);
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(hermes.root, "notes.txt"), "utf8"),
          "my notes\n",
        );
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses on a user's own edit inside a patched file, and puts the patch back", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });
        const edited = "backend = local\nremote_cwd = configured()\n# mine\n";
        NodeFS.writeFileSync(NodePath.join(hermes.root, "session.py"), edited);

        const error = yield* Effect.flip(service.updateHermes);
        assert.strictEqual(error.reason, "wrongState");
        assert.isFalse(NodeFS.existsSync(hermes.log));
        assert.strictEqual(hermes.read(), edited);
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the patches when the update fails, and reports the failure", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      NodeFS.writeFileSync(NodePath.join(hermes.base, "fail"), "");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: patch.id });

        const result = yield* service.updateHermes;
        assert.isTrue(result.updateFailed);
        assert.include(result.failureOutput ?? "", "network unreachable");
        assert.deepStrictEqual(result.reapplied, [patch.id]);
        assert.strictEqual(hermes.head(), hermes.older);
        assert.strictEqual(hermes.read(), "backend = local\nremote_cwd = configured()\n");
        assert.strictEqual(result.snapshot.patches[0]?.state, "applied");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses on a detached HEAD, which an update cannot move", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      git(hermes.root, "checkout", "--quiet", "--detach");
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const snapshot = yield* service.list;
        assert.isFalse(snapshot.canUpdateHermes);
        const error = yield* Effect.flip(service.updateHermes);
        assert.strictEqual(error.reason, "wrongState");
        assert.isFalse(NodeFS.existsSync(hermes.log));
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("why a Hermes patch does not apply", () => {
  it.effect("says Hermes is too old when HEAD is an ancestor of the newest version's commit", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      // Only the newer version ships, so the older checkout cannot take it.
      const patch = hermes.patch([hermes.newerVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        const status = yield* stateOf(service);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to commit dates when the version's commit was never fetched", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const unfetched = (date: string): HermesPatchVersion => ({
        ...hermes.newerVersion,
        hermesCommit: "0123456789abcdef0123456789abcdef01234567",
        hermesCommitDate: date,
      });
      // The newer version's content does not fit the older checkout.
      const later = hermes.patch([unfetched("2026-09-20T00:00:00Z")]);
      const earlier = hermes.patch([unfetched("2026-08-01T00:00:00Z")]);
      yield* Effect.gen(function* () {
        assert.strictEqual((yield* stateOf(yield* HermesPatchService))?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [later]));
      yield* Effect.gen(function* () {
        assert.strictEqual(
          (yield* stateOf(yield* HermesPatchService))?.reason,
          "awaitingPatchUpdate",
        );
      }).pipe(withService(hermes.binaryPath, [earlier]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says a T3 Code update is needed once Hermes has moved past every version", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion, hermes.olderVersion]);
      hermes.pushNewest();
      git(hermes.root, "pull", "--quiet", "--ff-only");
      yield* Effect.gen(function* () {
        const status = yield* stateOf(yield* HermesPatchService);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "awaitingPatchUpdate");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("blames local edits in the patched files before either update", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      const patch = hermes.patch([hermes.newerVersion]);
      NodeFS.writeFileSync(
        NodePath.join(hermes.root, "session.py"),
        "backend = mine\nremote_cwd = None\n",
      );
      yield* Effect.gen(function* () {
        const status = yield* stateOf(yield* HermesPatchService);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "localChanges");
      }).pipe(withService(hermes.binaryPath, [patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not blame edits another applied patch made to the same file", () =>
    Effect.gen(function* () {
      const hermes = yield* makeHermes;
      // Another patch adds a line to session.py; ours only fits the newer commit.
      const other: HermesPatchDefinition = {
        id: HermesPatchId.make("other"),
        title: "Other",
        neededFor: "Tests.",
        versions: [
          versionAt(
            hermes.root,
            "session.py",
            "backend = local\nremote_cwd = None\nextra = True\n",
            hermes.older,
            OLDER_DATE,
          ),
        ],
      };
      const patch = hermes.patch([hermes.newerVersion]);
      yield* Effect.gen(function* () {
        const service = yield* HermesPatchService;
        yield* service.apply({ patchId: other.id });
        const snapshot = yield* service.list;
        const status = snapshot.patches.find((candidate) => candidate.id === patch.id);
        assert.strictEqual(status?.state, "doesNotApply");
        assert.strictEqual(status?.reason, "hermesTooOld");
      }).pipe(withService(hermes.binaryPath, [other, patch]));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
