/**
 * HermesPatchService — status and apply/remove for the Hermes patches this
 * server ships, against the checkout of the environment's enabled Hermes,
 * plus restarting the Hermes gateway so it runs the patched code.
 *
 * Nothing is cached: every call reads the checkout and the gateway, because
 * `hermes update` or a terminal can change either between two clicks. The
 * one piece of state kept here is the restart this server is running.
 *
 * @module HermesPatchService
 */
import {
  HermesPatchError,
  type HermesGatewayStatus,
  type HermesPatchChangeInput,
  type HermesPatchesAvailability,
  type HermesPatchesSnapshot,
} from "@t3tools/contracts";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import {
  describeRestartOutput,
  latestModifiedMs,
  readRunningHermesGateway,
  type RunningHermesGateway,
} from "./hermesGateway.ts";
import {
  changeHermesPatch,
  HERMES_PATCHES,
  hermesPatchedSourceFiles,
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
    /**
     * Starts `hermes gateway restart` and returns at once. The gateway drains
     * its in-flight work first, which can take minutes; the snapshot reads
     * `restarting` until the command finishes.
     */
    readonly restartGateway: Effect.Effect<HermesPatchesSnapshot, HermesPatchError>;
    /** Waits for the restart `restartGateway` started, if one is running. */
    readonly awaitGatewayRestart: Effect.Effect<void>;
  }
>()("t3-hermes/hermes/HermesPatchService") {}

const unavailableSnapshot = (availability: HermesPatchesAvailability): HermesPatchesSnapshot => ({
  availability,
  checkoutPath: null,
  detachedHead: false,
  patches: [],
  gateway: null,
  gatewayRestartFailure: null,
});

/** The patched source files, read once: the shipped patches never change at runtime. */
const PATCHED_SOURCE_FILES = hermesPatchedSourceFiles();

/**
 * Supervisors that bring a gateway back after `hermes gateway restart` stops
 * it. A `manual` gateway was started in a terminal, and the CLI would run its
 * replacement in the foreground as a child of this server. Hermes Desktop
 * (`desktop`) and Windows gateways restart from their own controls.
 */
const RESTARTABLE_SUPERVISORS = new Set(["systemd", "launchd", "external"]);
const isRestartable = (gateway: RunningHermesGateway) =>
  RESTARTABLE_SUPERVISORS.has(gateway.supervisor);

/** How long to wait for a restarted gateway's control socket: 10 × 1s. */
const REPLACEMENT_ATTEMPTS = 10;
const REPLACEMENT_RETRY_DELAY = "1 second";

interface GatewayRestart {
  readonly running: boolean;
  /** Why the last restart failed, and the gateway pid it left answering (null: none). */
  readonly failure: { readonly detail: string; readonly gatewayPid: number | null } | null;
  readonly fiber: Fiber.Fiber<void> | null;
}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Two clicks racing on one checkout would both pass the state check.
  const changeLock = yield* Semaphore.make(1);
  const restartRef = yield* Ref.make<GatewayRestart>({
    running: false,
    failure: null,
    fiber: null,
  });
  // A restart outlives the request that started it, but not the server.
  const restartScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

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
      return {
        availability: "ready",
        checkoutRoot,
        binary: instance.settings.binaryPath || "hermes",
        env,
        hermesHome: resolveHermesHome(env),
      } as const;
    }),
  );
  type Checkout = Extract<Effect.Success<typeof locateCheckout>, { availability: "ready" }>;

  /** The running gateway, or null when none answers; never fails the read. */
  const readGateway = (hermesHome: string) =>
    Effect.promise(() => readRunningHermesGateway(hermesHome)).pipe(
      Effect.orElseSucceed(() => null),
    );

  const readGatewayStatus = (checkout: Checkout) =>
    Effect.gen(function* () {
      const restart = yield* Ref.get(restartRef);
      const gateway = yield* readGateway(checkout.hermesHome);
      // A failure describes the gateway it left behind. Once another one
      // answers, say one started by hand, the failure is history.
      const failure =
        restart.failure !== null && restart.failure.gatewayPid === (gateway?.pid ?? null)
          ? restart.failure.detail
          : null;
      if (restart.running) {
        return { status: { state: "restarting", canRestart: true } as const, failure: null };
      }
      if (gateway === null) return { status: null, failure };
      const changedAtMs = yield* Effect.promise(() =>
        latestModifiedMs(checkout.checkoutRoot, PATCHED_SOURCE_FILES),
      ).pipe(Effect.orElseSucceed(() => null));
      const status: HermesGatewayStatus = {
        state: changedAtMs !== null && changedAtMs > gateway.startedAtMs ? "outdated" : "upToDate",
        canRestart: isRestartable(gateway),
      };
      return { status, failure };
    });

  const readSnapshot = (checkout: Checkout) =>
    provide(
      Effect.all({
        patches: readHermesPatches(checkout.checkoutRoot),
        detachedHead: isHermesCheckoutDetached(checkout.checkoutRoot),
        gateway: readGatewayStatus(checkout),
      }),
    ).pipe(
      Effect.map(({ patches, detachedHead, gateway }): HermesPatchesSnapshot => ({
        availability: "ready",
        checkoutPath: checkout.checkoutRoot,
        detachedHead,
        patches,
        gateway: gateway.status,
        gatewayRestartFailure: gateway.failure,
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
    return yield* readSnapshot(checkout);
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
      const before = yield* readSnapshot(checkout);
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
      return yield* readSnapshot(checkout);
    }).pipe(changeLock.withPermits(1));

  /** The gateway answering once one other than `previousPid` does, or the last read. */
  const awaitReplacement = (hermesHome: string, previousPid: number) =>
    Effect.gen(function* () {
      let gateway = yield* readGateway(hermesHome);
      for (let attempt = 1; attempt < REPLACEMENT_ATTEMPTS; attempt++) {
        if (gateway !== null && gateway.pid !== previousPid) break;
        yield* Effect.sleep(REPLACEMENT_RETRY_DELAY);
        gateway = yield* readGateway(hermesHome);
      }
      return gateway;
    });

  /**
   * Runs `hermes gateway restart` with the instance's environment, so its
   * `HERMES_HOME` picks the gateway. Hermes owns the how: it drains in-flight
   * turns, then hands the restart to systemd, launchd, or whatever supervises
   * the gateway. Success means a different gateway answers afterwards; the
   * CLI exits 0 on some paths that leave the old one running.
   */
  const runRestart = (checkout: Checkout, previousPid: number) =>
    Effect.gen(function* () {
      const args = ["gateway", "restart"];
      const spawnCommand = yield* resolveSpawnCommand(checkout.binary, args, { env: checkout.env });
      const result = yield* spawnAndCollect(
        checkout.binary,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: checkout.env,
          shell: spawnCommand.shell,
        }),
      );
      // The replacement can be alive before its control socket answers.
      const after =
        result.code === 0
          ? yield* awaitReplacement(checkout.hermesHome, previousPid)
          : yield* readGateway(checkout.hermesHome);
      if (result.code === 0 && after !== null && after.pid !== previousPid) return null;
      yield* Effect.logWarning("hermes gateway restart did not replace the gateway").pipe(
        Effect.annotateLogs({ exitCode: result.code, replaced: after?.pid !== previousPid }),
      );
      const gatewayPid = after?.pid ?? null;
      const output = describeRestartOutput(result.stdout, result.stderr);
      if (result.code !== 0) {
        return {
          detail: `hermes gateway restart exited with code ${result.code}.${output ? ` ${output}` : ""}`,
          gatewayPid,
        };
      }
      return {
        detail:
          after === null
            ? "The gateway stopped and did not come back. Start it with hermes gateway start."
            : "The gateway is still the one from before. Check hermes gateway status on the host.",
        gatewayPid,
      };
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed({
          detail: "Could not run hermes gateway restart.",
          gatewayPid: previousPid,
        }),
      ),
      Effect.flatMap((failure) =>
        Ref.update(restartRef, (current) => ({ ...current, running: false, failure })),
      ),
    );

  const restartGateway = Effect.gen(function* () {
    const checkout = yield* locateCheckout;
    if (checkout.availability !== "ready") {
      return yield* new HermesPatchError({
        reason: "unavailable",
        detail: "There is no Hermes git checkout here.",
      });
    }
    const gateway = yield* readGateway(checkout.hermesHome);
    // One step: an interrupt between marking `running` and forking would
    // leave the tab reading "restarting" until the server restarts.
    const started = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* Ref.modify(restartRef, (current): [boolean, GatewayRestart] => {
          if (current.running) return [false, current];
          if (gateway === null || !isRestartable(gateway)) return [false, current];
          return [true, { running: true, failure: null, fiber: null }];
        });
        if (!claimed || gateway === null) return false;
        const fiber = yield* provide(runRestart(checkout, gateway.pid)).pipe(
          Effect.forkIn(restartScope),
        );
        yield* Ref.update(restartRef, (current) => ({ ...current, fiber }));
        return true;
      }),
    );
    if (started) {
      // The answer to this request is "it started", however fast it finishes.
      const snapshot = yield* readSnapshot(checkout);
      return {
        ...snapshot,
        gateway: { state: "restarting", canRestart: true },
        gatewayRestartFailure: null,
      } satisfies HermesPatchesSnapshot;
    }
    if (!(yield* Ref.get(restartRef)).running) {
      return yield* new HermesPatchError({
        reason: "wrongState",
        detail:
          gateway === null
            ? "No Hermes gateway is running."
            : "This gateway does not run as a service. Restart it where it was started.",
      });
    }
    return yield* readSnapshot(checkout);
  });

  return HermesPatchService.of({
    list,
    apply: (input) => change(input, "forward"),
    revert: (input) => change(input, "reverse"),
    restartGateway,
    awaitGatewayRestart: Ref.get(restartRef).pipe(
      Effect.flatMap(({ fiber }) => (fiber === null ? Effect.void : Fiber.await(fiber))),
      Effect.asVoid,
    ),
  });
});

export const layer = Layer.effect(HermesPatchService, make);
