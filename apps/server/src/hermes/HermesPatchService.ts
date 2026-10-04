/**
 * HermesPatchService — status and apply/remove for the Hermes patches this
 * server ships, against the checkout of the environment's enabled Hermes, and
 * `hermes update` with the patches lifted off and put back around it.
 *
 * Nothing is cached: every call reads the checkout, because `hermes update`
 * or a terminal can change it between two clicks.
 *
 * @module HermesPatchService
 */
import {
  HermesPatchError,
  type HermesPatchChangeInput,
  type HermesPatchesAvailability,
  type HermesPatchesSnapshot,
  type HermesPatchId,
  type HermesPatchUpdateHermesResult,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance } from "./hermesCronState.ts";
import {
  changeHermesPatch,
  HERMES_PATCHES,
  hermesPatchesPaths,
  isHermesCheckoutDetached,
  readHermesDirtyPaths,
  readHermesHeadCommit,
  readHermesPatches,
  resolveHermesGitCheckout,
  type HermesPatchDefinition,
} from "./hermesPatches.ts";

export class HermesPatchService extends Context.Service<
  HermesPatchService,
  {
    readonly list: Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    readonly apply: (
      input: HermesPatchChangeInput,
    ) => Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    readonly revert: (
      input: HermesPatchChangeInput,
    ) => Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    readonly updateHermes: Effect.Effect<HermesPatchUpdateHermesResult, HermesPatchError>;
  }
>()("t3-hermes/hermes/HermesPatchService") {}

const unavailableSnapshot = (availability: HermesPatchesAvailability): HermesPatchesSnapshot => ({
  availability,
  checkoutPath: null,
  detachedHead: false,
  patches: [],
});

export interface HermesPatchServiceOptions {
  /** Patches to manage; the shipped ones by default. Tests pass fixtures. */
  readonly patches?: ReadonlyArray<HermesPatchDefinition>;
  /** How long `hermes update` may run before it is stopped. */
  readonly updateTimeout?: Duration.Input;
}

/** Keeps the end of a long update log, where the failure usually is. */
const outputTail = (output: string, limit = 2_000) =>
  output.length <= limit ? output : `…${output.slice(output.length - limit)}`;

export const makeWith = Effect.fnUntraced(function* (options: HermesPatchServiceOptions = {}) {
  const shippedPatches = options.patches ?? HERMES_PATCHES;
  const updateTimeout = options.updateTimeout ?? "15 minutes";
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Two clicks racing on one checkout would both pass the state check.
  const changeLock = yield* Semaphore.make(1);

  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  /** The enabled Hermes's checkout, or why there is none. */
  const locateCheckout = provide(
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const instance = settings === null ? null : resolveEnabledHermesInstance(settings);
      if (instance === null) return { availability: "providerDisabled" } as const;
      const env = mergeProviderInstanceEnvironment(instance.environment);
      const commandPath = yield* resolveCommandPath(instance.settings.binaryPath || "hermes", {
        env,
      }).pipe(Effect.orElseSucceed(() => null));
      if (commandPath === null) return { availability: "hermesNotFound" } as const;
      const realCommandPath = yield* fileSystem
        .realPath(commandPath)
        .pipe(Effect.orElseSucceed(() => null));
      const checkoutRoot =
        realCommandPath === null ? null : yield* resolveHermesGitCheckout(realCommandPath);
      if (checkoutRoot === null) return { availability: "notGitCheckout" } as const;
      return { availability: "ready", checkoutRoot, commandPath, env } as const;
    }),
  );

  const readSnapshot = (checkoutRoot: string) =>
    provide(
      Effect.all({
        patches: readHermesPatches(checkoutRoot, shippedPatches),
        detachedHead: isHermesCheckoutDetached(checkoutRoot),
        headCommit: readHermesHeadCommit(checkoutRoot),
      }),
    ).pipe(
      Effect.map(({ patches, detachedHead, headCommit }): HermesPatchesSnapshot => ({
        availability: "ready",
        checkoutPath: checkoutRoot,
        detachedHead,
        ...(headCommit === null ? {} : { headCommit }),
        canUpdateHermes: !detachedHead,
        patches,
      })),
      Effect.mapError(
        (cause) =>
          new HermesPatchError({
            reason: "commandFailed",
            detail: "Could not read the Hermes checkout with git.",
            cause,
          }),
      ),
    );

  const list = Effect.gen(function* () {
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") return unavailableSnapshot(checkout.availability);
    return yield* readSnapshot(checkout.checkoutRoot);
  });

  const change = (input: HermesPatchChangeInput, direction: "forward" | "reverse") =>
    Effect.gen(function* () {
      const patch = shippedPatches.find((candidate) => candidate.id === input.patchId);
      if (patch === undefined) {
        return yield* new HermesPatchError({
          reason: "unknownPatch",
          detail: "This environment does not ship that patch.",
        });
      }
      const checkout = yield* locateCheckout;
      if (checkout.availability !== "ready") {
        return yield* new HermesPatchError({
          reason: "unavailable",
          detail: "There is no Hermes git checkout to patch.",
        });
      }
      const before = yield* readSnapshot(checkout.checkoutRoot);
      const expected = direction === "forward" ? "notApplied" : "applied";
      if (before.patches.find((candidate) => candidate.id === patch.id)?.state !== expected) {
        return yield* new HermesPatchError({
          reason: "wrongState",
          detail:
            direction === "forward"
              ? "The patch does not apply to this Hermes checkout as it is now."
              : "The patch is not applied to this Hermes checkout.",
        });
      }
      const result = yield* provide(
        changeHermesPatch(checkout.checkoutRoot, patch, direction),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new HermesPatchError({
              reason: "commandFailed",
              detail: "Could not run git in the Hermes checkout.",
              cause,
            }),
        ),
      );
      if (!result.ok) {
        yield* Effect.logWarning("git refused a Hermes patch change").pipe(
          Effect.annotateLogs({ patchId: patch.id, direction }),
        );
        return yield* new HermesPatchError({
          reason: "commandFailed",
          detail:
            direction === "forward"
              ? "git refused to apply the patch. The checkout was left unchanged."
              : "git refused to remove the patch. The checkout was left unchanged.",
        });
      }
      return yield* readSnapshot(checkout.checkoutRoot);
    }).pipe(changeLock.withPermits(1));

  const gitFailed = (detail: string) => (cause: unknown) =>
    new HermesPatchError({ reason: "commandFailed", detail, cause });

  /**
   * Puts each patch back with whichever version fits the checkout now, and
   * sorts the ones that would not go back by why.
   */
  const reapply = (checkoutRoot: string, patches: ReadonlyArray<HermesPatchDefinition>) =>
    Effect.gen(function* () {
      const reapplied: HermesPatchId[] = [];
      const failed: HermesPatchId[] = [];
      for (const patch of patches) {
        const result = yield* provide(changeHermesPatch(checkoutRoot, patch, "forward")).pipe(
          Effect.orElseSucceed(() => ({ ok: false }) as const),
        );
        (result.ok ? reapplied : failed).push(patch.id);
      }
      const snapshot = yield* readSnapshot(checkoutRoot);
      const reasonOf = (id: HermesPatchId) =>
        snapshot.patches.find((candidate) => candidate.id === id)?.reason;
      return {
        snapshot,
        reapplied,
        awaitingPatchUpdate: failed.filter((id) => reasonOf(id) === "awaitingPatchUpdate"),
        notReapplied: failed.filter((id) => reasonOf(id) !== "awaitingPatchUpdate"),
      };
    });

  /**
   * Runs `hermes update` without prompts or stash restore. The gateway restart
   * is deferred: it would otherwise restart on the code before our patches go
   * back on, so the user restarts it once they have.
   */
  const runHermesUpdate = (checkout: {
    readonly checkoutRoot: string;
    readonly commandPath: string;
    readonly env: NodeJS.ProcessEnv;
  }) =>
    Effect.gen(function* () {
      const args = ["update", "--yes", "--keep-stash", "--no-gateway-restart"];
      const spawn = yield* resolveSpawnCommand(checkout.commandPath, args, { env: checkout.env });
      const result = yield* provide(
        spawnAndCollect(
          checkout.commandPath,
          ChildProcess.make(spawn.command, spawn.args, {
            cwd: checkout.checkoutRoot,
            env: checkout.env,
            shell: spawn.shell,
          }),
        ),
      ).pipe(Effect.timeoutOption(updateTimeout));
      if (Option.isNone(result)) {
        return { ok: false, output: "hermes update did not finish in time and was stopped." };
      }
      const output = `${result.value.stdout}${result.value.stderr}`;
      return { ok: result.value.code === 0, output };
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({ ok: false, output: `Could not run hermes update: ${String(cause)}` }),
      ),
    );

  const updateHermes = Effect.gen(function* () {
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") {
      return yield* new HermesPatchError({
        reason: "unavailable",
        detail: "Hermes is not installed from a git checkout, so T3 Code cannot update it.",
      });
    }
    const { checkoutRoot } = checkout;
    const before = yield* readSnapshot(checkoutRoot);
    if (before.detachedHead) {
      return yield* new HermesPatchError({
        reason: "wrongState",
        detail:
          "The Hermes checkout is on a detached HEAD, so updating cannot move it. Check out main in the checkout first.",
      });
    }
    const applied = shippedPatches.filter((patch) =>
      before.patches.some((status) => status.id === patch.id && status.state === "applied"),
    );
    const refuseLocalChanges = (paths: ReadonlyArray<string>) =>
      new HermesPatchError({
        reason: "wrongState",
        detail: `The Hermes checkout has uncommitted changes of your own (${paths.length === 1 ? paths[0] : `${paths[0]} and ${paths.length - 1} more`}). Updating would park them in a git stash, so commit or discard them first.`,
      });
    // Edits in files no applied patch touches can only be the user's.
    const ours = hermesPatchesPaths(applied);
    const dirty = yield* provide(readHermesDirtyPaths(checkoutRoot)).pipe(
      Effect.mapError(gitFailed("Could not read the Hermes checkout with git.")),
    );
    const foreign = [...dirty].filter((path) => !ours.has(path)).sort();
    if (foreign.length > 0) return yield* refuseLocalChanges(foreign);

    const removed: HermesPatchDefinition[] = [];
    for (const patch of applied) {
      const result = yield* provide(changeHermesPatch(checkoutRoot, patch, "reverse")).pipe(
        Effect.orElseSucceed(() => ({ ok: false }) as const),
      );
      if (!result.ok) {
        yield* reapply(checkoutRoot, removed);
        return yield* new HermesPatchError({
          reason: "commandFailed",
          detail: `git refused to remove ${patch.title} before updating. Hermes was not updated.`,
        });
      }
      removed.push(patch);
    }
    // Whatever is still dirty is the user's own edit inside a patched file.
    const leftover = yield* provide(readHermesDirtyPaths(checkoutRoot)).pipe(
      Effect.orElseSucceed(() => new Set<string>()),
    );
    if (leftover.size > 0) {
      yield* reapply(checkoutRoot, removed);
      return yield* refuseLocalChanges([...leftover].sort());
    }

    const update = yield* runHermesUpdate(checkout);
    if (!update.ok) {
      yield* Effect.logWarning("hermes update failed").pipe(
        Effect.annotateLogs({ output: outputTail(update.output) }),
      );
    }
    const restored = yield* reapply(checkoutRoot, removed);
    return {
      ...restored,
      previousHeadCommit: before.headCommit ?? null,
      updateFailed: !update.ok,
      failureOutput: update.ok ? null : outputTail(update.output),
    } satisfies HermesPatchUpdateHermesResult;
  }).pipe(changeLock.withPermits(1));

  return HermesPatchService.of({
    list,
    apply: (input) => change(input, "forward"),
    revert: (input) => change(input, "reverse"),
    updateHermes,
  });
});

export const make = makeWith();

export const layer = Layer.effect(HermesPatchService, make);
