/**
 * The Hermes patches this server ships, and the git calls that read and change
 * them in a Hermes checkout.
 *
 * Each patch ships several versions, each made for a different Hermes commit
 * (`infra/hermes/patches.json`), because users' checkouts sit anywhere along
 * Hermes `main`. State is read with `git apply --check` in both directions
 * rather than recorded anywhere, so it is right no matter who touched the
 * checkout last: T3 Code, `hermes update`'s autostash, or someone at a terminal.
 */
import {
  HermesPatchId,
  type HermesPatch,
  type HermesPatchMisfitReason,
  type HermesPatchState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { HERMES_PATCH_FILES } from "./hermesPatchFiles.generated.ts";

export interface HermesPatchVersion {
  /** The Hermes commit this version was made and verified against. */
  readonly hermesCommit: string;
  readonly hermesCommitDate: string;
  /** Patch text, as `git apply` reads it. */
  readonly content: string;
}

export interface HermesPatchDefinition {
  readonly id: HermesPatchId;
  readonly title: string;
  readonly neededFor: string;
  /** Newest first. */
  readonly versions: ReadonlyArray<HermesPatchVersion>;
}

export const HERMES_PATCHES: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCH_FILES.map(
  (patch) => ({
    id: HermesPatchId.make(patch.id),
    title: patch.title,
    neededFor: patch.neededFor,
    versions: patch.versions.map(({ hermesCommit, hermesCommitDate, content }) => ({
      hermesCommit,
      hermesCommitDate,
      content,
    })),
  }),
);

/**
 * The git checkout a Hermes executable was installed from, or null.
 *
 * A source install puts the binary at `<checkout>/venv/bin/hermes`. Nix,
 * Docker, apt and pip installs have no checkout beside them; `hermes update`
 * refuses those too.
 */
export const resolveHermesGitCheckout = Effect.fn("resolveHermesGitCheckout")(function* (
  realCommandPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkoutRoot = path.dirname(path.dirname(path.dirname(realCommandPath)));
  const isGitCheckout = yield* fileSystem
    .exists(path.join(checkoutRoot, ".git"))
    .pipe(Effect.orElseSucceed(() => false));
  return isGitCheckout ? checkoutRoot : null;
});

/**
 * Runs git in the checkout. Inherited repository bindings (a server started
 * from a git hook, say) would otherwise point git at a different repository.
 */
const runGit = (checkoutRoot: string, args: ReadonlyArray<string>) =>
  spawnAndCollect(
    "git",
    ChildProcess.make("git", args, {
      cwd: checkoutRoot,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      },
    }),
  );

/** Writes every version of the given patches to a scoped temp directory for `git apply`. */
const writePatchFiles = Effect.fn("writeHermesPatchFiles")(function* (
  patches: ReadonlyArray<HermesPatchDefinition>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-patches-" });
  const files = new Map<HermesPatchId, ReadonlyArray<string>>();
  for (const patch of patches) {
    const versionFiles: string[] = [];
    for (const [index, version] of patch.versions.entries()) {
      const file = path.join(directory, `${patch.id}.${index}.patch`);
      yield* fileSystem.writeFileString(file, version.content);
      versionFiles.push(file);
    }
    files.set(patch.id, versionFiles);
  }
  return files;
});

// Every patch is read at once, so this keeps a full read to a few dozen git
// processes however many versions the manifest retains.
const GIT_CHECK_CONCURRENCY = 4;

/**
 * The first version file, newest first, that git accepts. `--check` only reads
 * the checkout, so the versions are checked side by side rather than one git
 * process after another.
 */
const firstFitting = (
  checkoutRoot: string,
  versionFiles: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
) =>
  Effect.forEach(versionFiles, (file) => runGit(checkoutRoot, [...args, file]), {
    concurrency: GIT_CHECK_CONCURRENCY,
  }).pipe(Effect.map((results) => versionFiles.find((_, index) => results[index]?.code === 0)));

/**
 * Where one patch stands, and the version file that got it there: the version
 * whose change the checkout contains, or the one that applies cleanly.
 */
const resolvePatchState = Effect.fn("resolveHermesPatchState")(function* (
  checkoutRoot: string,
  versionFiles: ReadonlyArray<string>,
) {
  const result = (state: HermesPatchState, file: string | null) => ({ state, file });
  // Reverse first, over every version: a checkout that already has a change
  // must read as applied, not as a conflict of a forward patch with itself.
  const reverse = yield* firstFitting(checkoutRoot, versionFiles, ["apply", "--check", "-R"]);
  if (reverse !== undefined) return result("applied", reverse);
  const forward = yield* firstFitting(checkoutRoot, versionFiles, ["apply", "--check"]);
  if (forward !== undefined) return result("notApplied", forward);
  return result("doesNotApply", null);
});

/** Repository paths a patch version changes, from its `--- a/` and `+++ b/` headers. */
const hermesPatchPaths = (content: string): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^(?:---|\+\+\+) [ab]\/(.+)$/.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return [...paths];
};

/** Paths every version of a patch touches. */
const patchPaths = (patch: HermesPatchDefinition) =>
  new Set(patch.versions.flatMap((version) => hermesPatchPaths(version.content)));

/**
 * Paths with uncommitted changes, untracked files included: those are what
 * `hermes update`'s autostash would sweep away.
 */
export const readHermesDirtyPaths = Effect.fn("readHermesDirtyPaths")(function* (
  checkoutRoot: string,
) {
  const result = yield* runGit(checkoutRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const paths = new Set<string>();
  const fields = result.stdout.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
    // A rename or copy carries its source path as the next field.
    if (entry[0] === "R" || entry[0] === "C") {
      const source = fields[++index];
      if (source) paths.add(source);
    }
  }
  return paths;
});

/** The checkout's HEAD, abbreviated, or null in a repository without commits. */
export const readHermesHeadCommit = (checkoutRoot: string) =>
  runGit(checkoutRoot, ["rev-parse", "--short", "HEAD"]).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout.trim() || null : null)),
  );

const isAncestor = (checkoutRoot: string, ancestor: string, descendant: string) =>
  runGit(checkoutRoot, ["merge-base", "--is-ancestor", ancestor, descendant]).pipe(
    Effect.map((result) => result.code === 0),
  );

/**
 * Whether HEAD is older than a version's Hermes commit, so updating Hermes
 * moves toward it. Ancestry decides when the commit is known locally; a commit
 * the checkout has never fetched, or one on a diverged line, falls back to
 * comparing HEAD's committer date with the recorded commit date.
 */
const isHeadOlderThan = Effect.fn("isHermesHeadOlderThan")(function* (
  checkoutRoot: string,
  version: HermesPatchVersion,
) {
  const known = yield* runGit(checkoutRoot, ["cat-file", "-e", `${version.hermesCommit}^{commit}`]);
  if (known.code === 0) {
    // Checked first so HEAD at the version's own commit reads as not older.
    if (yield* isAncestor(checkoutRoot, version.hermesCommit, "HEAD")) return false;
    if (yield* isAncestor(checkoutRoot, "HEAD", version.hermesCommit)) return true;
  }
  const headDate = yield* runGit(checkoutRoot, ["log", "-1", "--format=%cI", "HEAD"]);
  const head = Date.parse(headDate.stdout.trim());
  const recorded = Date.parse(version.hermesCommitDate);
  return Number.isFinite(head) && Number.isFinite(recorded) && head < recorded;
});

/**
 * Why a patch that applies in neither direction does not fit, which decides
 * what the user can do about it. `explainedPaths` are paths changed by
 * patches that are applied, so their edits are ours, not the user's.
 */
const classifyHermesPatchMisfit = Effect.fn("classifyHermesPatchMisfit")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  context: {
    readonly dirtyPaths: ReadonlySet<string>;
    readonly explainedPaths: ReadonlySet<string>;
  },
) {
  for (const path of patchPaths(patch)) {
    if (context.dirtyPaths.has(path) && !context.explainedPaths.has(path)) {
      return "localChanges" satisfies HermesPatchMisfitReason;
    }
  }
  const newest = patch.versions[0];
  if (newest === undefined) return "awaitingPatchUpdate" satisfies HermesPatchMisfitReason;
  const reason: HermesPatchMisfitReason = (yield* isHeadOlderThan(checkoutRoot, newest))
    ? "hermesTooOld"
    : "awaitingPatchUpdate";
  return reason;
});

export const readHermesPatches = Effect.fn("readHermesPatches")(function* (
  checkoutRoot: string,
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
) {
  const files = yield* writePatchFiles(patches);
  // Patches are read independently, so read them all at once.
  const states = new Map<HermesPatchId, HermesPatchState>(
    yield* Effect.forEach(
      patches,
      (patch) =>
        resolvePatchState(checkoutRoot, files.get(patch.id) ?? []).pipe(
          Effect.map(({ state }) => [patch.id, state] as const),
        ),
      { concurrency: "unbounded" },
    ),
  );
  const misfits = patches.filter((patch) => states.get(patch.id) === "doesNotApply");
  const context =
    misfits.length === 0
      ? null
      : {
          dirtyPaths: yield* readHermesDirtyPaths(checkoutRoot),
          explainedPaths: new Set(
            patches
              .filter((patch) => states.get(patch.id) === "applied")
              .flatMap((patch) => [...patchPaths(patch)]),
          ),
        };
  const statuses: HermesPatch[] = [];
  for (const patch of patches) {
    const state = states.get(patch.id) ?? "doesNotApply";
    const status: HermesPatch = {
      id: patch.id,
      title: patch.title,
      neededFor: patch.neededFor,
      state,
    };
    statuses.push(
      state === "doesNotApply" && context !== null
        ? { ...status, reason: yield* classifyHermesPatchMisfit(checkoutRoot, patch, context) }
        : status,
    );
  }
  return statuses;
}, Effect.scoped);

/** Paths changed by any version of the given patches. */
export const hermesPatchesPaths = (patches: ReadonlyArray<HermesPatchDefinition>) =>
  new Set(patches.flatMap((patch) => [...patchPaths(patch)]));

/** True when HEAD is not on a branch, which `hermes update` cannot move. */
export const isHermesCheckoutDetached = (checkoutRoot: string) =>
  runGit(checkoutRoot, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
    Effect.map((result) => result.code !== 0),
  );

/**
 * Applies (`forward`) or removes (`reverse`) one patch, returning whether git
 * accepted it. Applying uses the newest version that fits the checkout;
 * removing reverses whichever version is applied. `git apply` is
 * all-or-nothing, so a refusal leaves the checkout untouched.
 */
export const changeHermesPatch = Effect.fn("changeHermesPatch")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  direction: "forward" | "reverse",
) {
  const files = yield* writePatchFiles([patch]);
  const { state, file } = yield* resolvePatchState(checkoutRoot, files.get(patch.id) ?? []);
  const expected: HermesPatchState = direction === "forward" ? "notApplied" : "applied";
  if (state !== expected || file === null) return { ok: false } as const;
  const result = yield* runGit(
    checkoutRoot,
    direction === "forward" ? ["apply", file] : ["apply", "-R", file],
  );
  return { ok: result.code === 0 } as const;
}, Effect.scoped);
