/**
 * HermesPatchService — status and apply/remove for the Hermes patches this
 * server ships, against the checkout of the environment's enabled Hermes.
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
} from "@t3tools/contracts";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance } from "./hermesCronState.ts";
import {
  changeHermesPatch,
  HERMES_PATCHES,
  isHermesCheckoutDetached,
  readHermesPatches,
  resolveHermesGitCheckout,
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
  }
>()("t3-hermes/hermes/HermesPatchService") {}

const unavailableSnapshot = (availability: HermesPatchesAvailability): HermesPatchesSnapshot => ({
  availability,
  checkoutPath: null,
  detachedHead: false,
  patches: [],
});

export const make = Effect.gen(function* () {
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
      return { availability: "ready", checkoutRoot } as const;
    }),
  );

  const readSnapshot = (checkoutRoot: string) =>
    provide(
      Effect.all({
        patches: readHermesPatches(checkoutRoot),
        detachedHead: isHermesCheckoutDetached(checkoutRoot),
      }),
    ).pipe(
      Effect.map(({ patches, detachedHead }): HermesPatchesSnapshot => ({
        availability: "ready",
        checkoutPath: checkoutRoot,
        detachedHead,
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
      const patch = HERMES_PATCHES.find((candidate) => candidate.id === input.patchId);
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

  return HermesPatchService.of({
    list,
    apply: (input) => change(input, "forward"),
    revert: (input) => change(input, "reverse"),
  });
});

export const layer = Layer.effect(HermesPatchService, make);
