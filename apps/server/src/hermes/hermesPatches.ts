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
import { HermesPatchId, type HermesPatch, type HermesPatchState } from "@t3tools/contracts";
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

/** Applying it also opts CLIProxyAPI endpoints in (`hermesFastModeConfig.ts`). */
export const HERMES_FAST_MODE_PATCH_ID = HermesPatchId.make("acp-fast-mode");

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
 * The non-test source files the patches touch, relative to the checkout.
 * A running gateway that started before one of them last changed still runs
 * the code from before the change.
 */
export const hermesPatchedSourceFiles = (
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
): ReadonlyArray<string> => {
  const files = new Set<string>();
  for (const patch of patches) {
    for (const version of patch.versions) {
      for (const match of version.content.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
        const file = match[2]!;
        if (!file.startsWith("tests/")) files.add(file);
      }
    }
  }
  return [...files];
};

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
const runGit = (
  checkoutRoot: string,
  args: ReadonlyArray<string>,
  env: { readonly GIT_INDEX_FILE?: string } = {},
) =>
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
        ...env,
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

// The ways of taking other applied patches out that are tried when picking
// the applied version: one per combination of their reversing versions.
const MAX_OTHER_COMBINATIONS = 16;

// Every patch is read at once, so this keeps a full read to a few dozen git
// processes however many versions the manifest retains.
const GIT_CHECK_CONCURRENCY = 4;

/**
 * The version files, newest first, that git accepts. `--check` only reads, so
 * the versions are checked side by side rather than one git process after
 * another.
 */
const fitting = (
  checkoutRoot: string,
  versionFiles: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
  env?: { readonly GIT_INDEX_FILE: string },
) =>
  Effect.forEach(versionFiles, (file) => runGit(checkoutRoot, [...args, file], env), {
    concurrency: GIT_CHECK_CONCURRENCY,
  }).pipe(Effect.map((results) => versionFiles.filter((_, index) => results[index]?.code === 0)));

/**
 * Every repository path a patch reads or writes, from its `diff --git`,
 * `rename`/`copy`, and `---`/`+++` headers: a rename's source as well as its
 * destination.
 */
const patchFilePaths = (content: string): ReadonlySet<string> => {
  const paths = new Set<string>();
  const header =
    /^(?:diff --git a\/(\S+) b\/(\S+)|(?:rename|copy) (?:from|to) (.+)|(?:---|\+\+\+) [ab]\/(.+))$/gm;
  for (const match of content.matchAll(header)) {
    for (const path of match.slice(1)) if (path !== undefined) paths.add(path);
  }
  return paths;
};

/**
 * Which of the versions that reverse cleanly is the one applied in the working
 * tree, or null when none can be told to be. A version reverses cleanly too
 * when upstream already carries its change, and two versions can patch
 * different upstream text into the same result, or the same text in different
 * places; reversing the wrong one would write the wrong text back.
 *
 * The applied one is a version that, applied to HEAD, gives exactly the files
 * the checkout has now once the other applied patches are taken back out:
 * patches can share a file, and their changes are not this one's. Failing
 * that (the user also edited those files), the one version that applies to
 * HEAD at all. Each check runs in its own
 * scratch index, so the checkout's own index is untouched. When neither picks
 * out exactly one, there is no telling, so null: the patch still reads as
 * applied, and Remove refuses rather than guess.
 */
const pickAppliedVersion = Effect.fn("pickHermesAppliedVersion")(function* (
  checkoutRoot: string,
  candidates: ReadonlyArray<string>,
  others: ReadonlyArray<ReadonlyArray<string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-index-" });
  const pathsOf = (files: ReadonlyArray<string>) =>
    Effect.forEach(files, (file) =>
      fileSystem.readFileString(file).pipe(Effect.map(patchFilePaths)),
    ).pipe(Effect.map((sets) => sets.flatMap((set) => [...set])));
  // Compared over every path any candidate touches, both sides of a rename
  // included: a version that changes fewer files would otherwise match while
  // another's change sits elsewhere. The other patches' paths are taken too,
  // so they can be reversed out of the snapshot whole.
  const candidatePaths = yield* pathsOf(candidates);
  if (candidatePaths.length === 0) return null;
  const paths = new Set([...candidatePaths, ...(yield* pathsOf(others.flat()))]);
  // The working tree over those paths, as a tree. Built through its own
  // scratch index so files a patch added, which `git apply` leaves
  // untracked, count too; a plain `git diff` would skip them.
  const worktreeEnv = { GIT_INDEX_FILE: path.join(directory, "index-worktree") };
  if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], worktreeEnv)).code !== 0) return null;
  const staged = yield* runGit(
    checkoutRoot,
    ["update-index", "--add", "--remove", "--", ...paths],
    worktreeEnv,
  );
  if (staged.code !== 0) return null;
  const worktreeTree = yield* runGit(checkoutRoot, ["write-tree"], worktreeEnv);
  if (worktreeTree.code !== 0) return null;
  // Out with every other patch applied here. Another patch can itself have
  // several versions that reverse, and only the applied one leaves the right
  // text behind, so each choice is tried: one per reversing version, across
  // the few patches that share these files.
  const choices: ReadonlyArray<string>[] = [];
  for (const versionFiles of others) {
    const reversing = yield* fitting(
      checkoutRoot,
      versionFiles,
      ["apply", "--check", "--cached", "-R"],
      worktreeEnv,
    );
    if (reversing.length > 0) choices.push(reversing);
  }
  const combinations = choices.reduce<ReadonlyArray<ReadonlyArray<string>>>(
    (acc, options) => acc.flatMap((combo) => options.map((file) => [...combo, file])),
    [[]],
  );
  if (combinations.length > MAX_OTHER_COMBINATIONS) return null;
  const normalized = new Set<string>();
  for (const [index, combo] of combinations.entries()) {
    const env = { GIT_INDEX_FILE: path.join(directory, `index-others-${index}`) };
    if ((yield* runGit(checkoutRoot, ["read-tree", worktreeTree.stdout.trim()], env)).code !== 0) {
      continue;
    }
    let reversedAll = true;
    for (const file of combo) {
      if ((yield* runGit(checkoutRoot, ["apply", "--cached", "-R", file], env)).code !== 0) {
        reversedAll = false;
        break;
      }
    }
    if (!reversedAll) continue;
    const tree = yield* runGit(checkoutRoot, ["write-tree"], env);
    if (tree.code === 0) normalized.add(tree.stdout.trim());
  }
  const checks = yield* Effect.forEach(
    candidates,
    (file, index) =>
      Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: path.join(directory, `index-${index}`) };
        if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) {
          return { file, onHead: false, matches: false };
        }
        if ((yield* runGit(checkoutRoot, ["apply", "--cached", file], env)).code !== 0) {
          return { file, onHead: false, matches: false };
        }
        const tree = yield* runGit(checkoutRoot, ["write-tree"], env);
        return {
          file,
          onHead: true,
          matches: tree.code === 0 && normalized.has(tree.stdout.trim()),
        };
      }),
    { concurrency: GIT_CHECK_CONCURRENCY },
  );
  // Any version that rebuilds the checkout exactly also undoes back to HEAD.
  const exact = checks.find((check) => check.matches);
  if (exact !== undefined) return exact.file;
  const onHead = checks.filter((check) => check.onHead);
  return onHead.length === 1 ? onHead[0]!.file : null;
}, Effect.scoped);

/**
 * Which of several versions that all apply is the one for this checkout: the
 * newest made for a commit HEAD already contains. Older versions can still fit
 * a newer checkout when they touch other occurrences of the same text, so
 * manifest order alone could apply the wrong one. When no recorded commit is
 * known here, the versions are still interchangeable if they all produce the
 * same tree from HEAD; otherwise null, and Apply refuses rather than guess.
 */
const pickForwardVersion = Effect.fn("pickHermesForwardVersion")(function* (
  checkoutRoot: string,
  candidates: ReadonlyArray<{ readonly file: string; readonly hermesCommit: string }>,
) {
  for (const candidate of candidates) {
    const contained = yield* runGit(checkoutRoot, [
      "merge-base",
      "--is-ancestor",
      candidate.hermesCommit,
      "HEAD",
    ]);
    if (contained.code === 0) return candidate.file;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-index-" });
  const trees = yield* Effect.forEach(
    candidates,
    (candidate, index) =>
      Effect.gen(function* () {
        const env = { GIT_INDEX_FILE: path.join(directory, `index-${index}`) };
        if ((yield* runGit(checkoutRoot, ["read-tree", "HEAD"], env)).code !== 0) return null;
        const applied = yield* runGit(checkoutRoot, ["apply", "--cached", candidate.file], env);
        if (applied.code !== 0) return null;
        const tree = yield* runGit(checkoutRoot, ["write-tree"], env);
        return tree.code === 0 ? tree.stdout.trim() : null;
      }),
    { concurrency: GIT_CHECK_CONCURRENCY },
  );
  const first = trees[0];
  return first != null && trees.every((tree) => tree === first) ? candidates[0]!.file : null;
}, Effect.scoped);

/**
 * Where one patch stands, and the version file that got it there: the version
 * whose change the checkout contains, or the one that applies cleanly. A null
 * file means the state is known but not which version made it, and changing it
 * is refused.
 */
const resolvePatchState = Effect.fn("resolveHermesPatchState")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  files: ReadonlyMap<HermesPatchId, ReadonlyArray<string>>,
) {
  const versionFiles = files.get(patch.id) ?? [];
  const others = [...files].filter(([id]) => id !== patch.id).map(([, other]) => other);
  const result = (state: HermesPatchState, file: string | null) => ({ state, file });
  // Reverse first, over every version: a checkout that already has a change
  // must read as applied, not as a conflict of a forward patch with itself.
  // Even a lone candidate is checked against HEAD: a change upstream now
  // carries reverses cleanly too, and removing it would rewrite upstream code.
  const reverse = yield* fitting(checkoutRoot, versionFiles, ["apply", "--check", "-R"]);
  if (reverse.length > 0) {
    return result("applied", yield* pickAppliedVersion(checkoutRoot, reverse, others));
  }
  const forward = yield* fitting(checkoutRoot, versionFiles, ["apply", "--check"]);
  if (forward.length === 1) return result("notApplied", forward[0]!);
  if (forward.length > 1) {
    const candidates = forward.map((file) => ({
      file,
      hermesCommit: patch.versions[versionFiles.indexOf(file)]?.hermesCommit ?? "",
    }));
    return result("notApplied", yield* pickForwardVersion(checkoutRoot, candidates));
  }
  return result("doesNotApply", null);
});

export const readHermesPatches = Effect.fn("readHermesPatches")(function* (
  checkoutRoot: string,
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
) {
  const files = yield* writePatchFiles(patches);
  // Patches are read independently, so read them all at once.
  return yield* Effect.forEach(
    patches,
    (patch) =>
      resolvePatchState(checkoutRoot, patch, files).pipe(
        Effect.map(({ state }): HermesPatch => ({
          id: patch.id,
          title: patch.title,
          neededFor: patch.neededFor,
          state,
        })),
      ),
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

/** True when HEAD is not on a branch, which `hermes update` cannot move. */
export const isHermesCheckoutDetached = (checkoutRoot: string) =>
  runGit(checkoutRoot, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
    Effect.map((result) => result.code !== 0),
  );

/**
 * Applies (`forward`) or removes (`reverse`) one patch, returning whether git
 * accepted it. Applying uses the newest version that fits the checkout;
 * removing reverses whichever version is applied. `git apply` is
 * all-or-nothing, so a refusal leaves the checkout untouched. `patches` is
 * every patch that may be applied alongside, so their changes in shared files
 * are told apart from this one's.
 */
export const changeHermesPatch = Effect.fn("changeHermesPatch")(function* (
  checkoutRoot: string,
  patch: HermesPatchDefinition,
  direction: "forward" | "reverse",
  patches: ReadonlyArray<HermesPatchDefinition> = HERMES_PATCHES,
) {
  const files = yield* writePatchFiles([
    patch,
    ...patches.filter((other) => other.id !== patch.id),
  ]);
  const { state, file } = yield* resolvePatchState(checkoutRoot, patch, files);
  const expected: HermesPatchState = direction === "forward" ? "notApplied" : "applied";
  if (state !== expected || file === null) return { ok: false } as const;
  const result = yield* runGit(
    checkoutRoot,
    direction === "forward" ? ["apply", file] : ["apply", "-R", file],
  );
  return { ok: result.code === 0 } as const;
}, Effect.scoped);
