/**
 * HermesCronService — reads Hermes Agent's scheduled jobs and pushes them to
 * subscribed clients.
 *
 * Hermes runs its own scheduler, so its jobs fire whether or not anyone is
 * looking at T3 Code. This service is the window onto that: it polls Hermes's
 * cron state, keeps one snapshot, and publishes a new one only when the state
 * actually differs from the last.
 *
 * Two cadences, in order of how much they cost:
 *
 * - **On demand.** A client subscribing or asking to refresh forces a read.
 * - **Subscribed poll (60s).** Runs only while at least one client is watching.
 *
 * Nothing streams continuously. An idle panel costs one read a minute and zero
 * websocket frames, and a closed panel costs nothing at all.
 *
 * Cron completion/failure notifications are therefore connected-client-only:
 * they ride the same subscription that the 60s poll keeps alive. The web
 * sidebar's watcher holds one subscription for as long as a Hermes-bearing
 * environment is connected, which is what makes a failed overnight job visible
 * when you open the app the next morning.
 *
 * The service is completely inert when the Hermes provider is disabled: no
 * timers, no file reads, no subprocess.
 *
 * @module HermesCronService
 */
import {
  HERMES_CRON_CONTRACT_VERSION,
  HermesCronError,
  type HermesCronJob,
  type HermesCronSetEnabledInput,
  type HermesCronSetMutedInput,
  type HermesCronSnapshot,
  type HermesCronStreamEvent,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import {
  buildRunLedger,
  diffCompletedRuns,
  type HermesCronRunLedger,
} from "./hermesCronNotifications.ts";
import {
  groupRunsByJob,
  parseHermesCronJobs,
  readHermesCronRuns,
  resolveHermesCronPaths,
  type ParsedHermesCronJob,
  type ParsedHermesCronRun,
} from "./hermesCronState.ts";

const decodeJobsFileJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Cadence while a client is watching the panel. */
const SUBSCRIBED_POLL_INTERVAL = Duration.seconds(60);

/** Mute is T3 Code's own state, so it lives beside the server's other state. */
const MUTE_STATE_FILENAME = "hermes-cron-mutes.json";

const PersistedMuteState = Schema.Struct({
  version: Schema.Literal(1),
  mutedJobIds: Schema.Array(Schema.String),
});

const decodeMuteState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedMuteState));

export class HermesCronService extends Context.Service<
  HermesCronService,
  {
    /** Current snapshot, re-read from Hermes when `refresh` is set. */
    readonly list: (input: {
      readonly refresh?: boolean;
    }) => Effect.Effect<HermesCronSnapshot, HermesCronError>;

    /** Pause or resume a job through the `hermes` CLI. */
    readonly setEnabled: (
      input: HermesCronSetEnabledInput,
    ) => Effect.Effect<HermesCronSnapshot, HermesCronError>;

    /** Mute or unmute this environment's notifications for a job. */
    readonly setMuted: (
      input: HermesCronSetMutedInput,
    ) => Effect.Effect<HermesCronSnapshot, HermesCronError>;

    /**
     * Snapshot followed by changes. Holding a subscription is what keeps the
     * 60s poll alive; the last unsubscribe stops it.
     */
    readonly subscribe: Effect.Effect<
      Stream.Stream<HermesCronStreamEvent>,
      HermesCronError,
      Scope.Scope
    >;
  }
>()("t3/hermes/HermesCronService") {}

interface PollResult {
  readonly snapshot: HermesCronSnapshot;
  readonly runs: readonly ParsedHermesCronRun[];
}

/**
 * Identity of a snapshot for change detection.
 *
 * `readAt` is excluded on purpose — it changes on every poll, and including it
 * would push a frame a minute to every subscriber forever.
 */
function snapshotIdentity(snapshot: HermesCronSnapshot): string {
  return JSON.stringify({
    availability: snapshot.availability,
    detail: snapshot.detail,
    runHistoryAvailable: snapshot.runHistoryAvailable,
    jobs: snapshot.jobs,
  });
}

function toContractJob(
  job: ParsedHermesCronJob,
  runs: readonly ParsedHermesCronRun[],
  muted: boolean,
): HermesCronJob {
  return {
    id: job.id as HermesCronJob["id"],
    name: job.name,
    scheduleDisplay: job.scheduleDisplay,
    state: job.state,
    enabled: job.enabled,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    lastError: job.lastError,
    deliver: job.deliver,
    muted,
    runs: runs.map((run) => ({
      id: run.id,
      jobId: run.jobId as HermesCronJob["id"],
      status: run.status,
      source: run.source,
      claimedAt: run.claimedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      error: run.error,
    })),
  };
}

function emptySnapshot(
  readAt: string,
  availability: HermesCronSnapshot["availability"],
  detail: string | null = null,
): HermesCronSnapshot {
  return {
    contractVersion: HERMES_CRON_CONTRACT_VERSION,
    readAt,
    availability,
    detail,
    runHistoryAvailable: false,
    jobs: [],
  };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  // Captured here so the service's own signature stays free of process
  // requirements; only `setEnabled` ever spawns anything.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;

  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<HermesCronStreamEvent>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const subscribeMutex = yield* Semaphore.make(1);
  const pollMutex = yield* Semaphore.make(1);

  const muteStatePath = path.join(config.stateDir, MUTE_STATE_FILENAME);
  const mutedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const snapshotRef = yield* Ref.make<HermesCronSnapshot | null>(null);
  /** `null` until the first successful poll — see `diffCompletedRuns`. */
  const ledgerRef = yield* Ref.make<HermesCronRunLedger | null>(null);
  const subscribersRef = yield* SynchronizedRef.make<{
    readonly count: number;
    readonly fiber: Fiber.Fiber<void> | null;
  }>({ count: 0, fiber: null });

  const pollerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  // A missing or unreadable mute file means "nothing muted", which is the safe
  // direction: a user hears about a run they muted rather than missing one.
  yield* Effect.gen(function* () {
    const exists = yield* fs.exists(muteStatePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return;
    const raw = yield* fs.readFileString(muteStatePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return;
    const decoded = yield* decodeMuteState(raw).pipe(Effect.option);
    if (decoded._tag === "Some") {
      yield* Ref.set(mutedRef, new Set(decoded.value.mutedJobIds));
    }
  });

  const persistMuteState = (mutedJobIds: ReadonlySet<string>) =>
    writeFileStringAtomically({
      filePath: muteStatePath,
      contents: `${JSON.stringify({ version: 1, mutedJobIds: [...mutedJobIds].sort() })}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      // Mute is a convenience. Losing it across a restart is not worth failing
      // a user's click over.
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to persist Hermes cron mute state").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );

  const hermesSettings = Effect.map(
    settingsService.getSettings.pipe(Effect.orElseSucceed(() => null)),
    (settings) => settings?.providers.hermes ?? null,
  );

  /** Reads Hermes state. Never fails — availability is part of the snapshot. */
  const readSnapshot = Effect.gen(function* () {
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const settings = yield* hermesSettings;

    if (settings === null || !settings.enabled) {
      return { snapshot: emptySnapshot(readAt, "providerDisabled"), runs: [] } satisfies PollResult;
    }

    const paths = resolveHermesCronPaths();
    const exists = yield* fs.exists(paths.jobsFile).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { snapshot: emptySnapshot(readAt, "noCronStore"), runs: [] } satisfies PollResult;
    }

    const raw = yield* fs.readFileString(paths.jobsFile).pipe(Effect.option);
    if (raw._tag === "None") {
      return {
        snapshot: emptySnapshot(readAt, "unreadable", "The Hermes cron store could not be read."),
        runs: [],
      } satisfies PollResult;
    }

    const parsed = yield* decodeJobsFileJson(raw.value).pipe(
      Effect.flatMap((json) => Effect.try(() => parseHermesCronJobs(json))),
      Effect.orElseSucceed(() => null),
    );
    if (parsed === null) {
      return {
        snapshot: emptySnapshot(
          readAt,
          "unreadable",
          "The Hermes cron store is not valid JSON. Run `hermes cron list` to check it.",
        ),
        runs: [],
      } satisfies PollResult;
    }

    const jobIds = parsed.map((job) => job.id);
    const runs = yield* Effect.sync(() => readHermesCronRuns(paths.executionsDb, jobIds));
    const grouped = groupRunsByJob(runs ?? []);
    const muted = yield* Ref.get(mutedRef);

    return {
      snapshot: {
        contractVersion: HERMES_CRON_CONTRACT_VERSION,
        readAt,
        availability: "ready" as const,
        detail: null,
        runHistoryAvailable: runs !== null,
        jobs: parsed.map((job) => toContractJob(job, grouped.get(job.id) ?? [], muted.has(job.id))),
      },
      runs: runs ?? [],
    } satisfies PollResult;
  });

  /**
   * One poll: read, publish if changed, notify on newly-terminal runs.
   *
   * Serialised so two subscribers cannot both diff against the same ledger
   * and double-notify.
   */
  const poll = pollMutex.withPermits(1)(
    Effect.gen(function* () {
      const result = yield* readSnapshot;
      const previousLedger = yield* Ref.get(ledgerRef);
      const muted = yield* Ref.get(mutedRef);

      const notifications = diffCompletedRuns({
        jobs: result.snapshot.jobs.map((job) => ({
          id: job.id,
          name: job.name,
        })) as unknown as readonly ParsedHermesCronJob[],
        runs: result.runs,
        previous: previousLedger,
        mutedJobIds: muted,
      });

      // Only advance the ledger once the runs were actually observed. A poll
      // that could not open the ledger leaves `previous` alone, so a run that
      // finished during the outage still notifies on the next good poll.
      if (result.snapshot.runHistoryAvailable) {
        yield* Ref.set(ledgerRef, buildRunLedger(result.runs));
      }

      const previousSnapshot = yield* Ref.get(snapshotRef);
      const changed =
        previousSnapshot === null ||
        snapshotIdentity(previousSnapshot) !== snapshotIdentity(result.snapshot);
      yield* Ref.set(snapshotRef, result.snapshot);

      if (changed) {
        yield* PubSub.publish(changes, { _tag: "snapshot", snapshot: result.snapshot });
      }
      for (const notification of notifications) {
        yield* PubSub.publish(changes, {
          _tag: "runCompleted",
          run: {
            jobId: notification.jobId as HermesCronJob["id"],
            jobName: notification.jobName,
            runId: notification.runId,
            status: notification.status,
            finishedAt: notification.finishedAt,
            error: notification.error,
          },
        });
      }

      return result.snapshot;
    }),
  );

  const currentSnapshot = Effect.gen(function* () {
    const existing = yield* Ref.get(snapshotRef);
    if (existing !== null) return existing;
    return yield* poll;
  });

  const retainPoller = SynchronizedRef.updateEffect(subscribersRef, (state) =>
    Effect.gen(function* () {
      if (state.fiber !== null) return { ...state, count: state.count + 1 };
      const fiber = yield* poll.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(SUBSCRIBED_POLL_INTERVAL)),
        Effect.asVoid,
        Effect.forkIn(pollerScope),
      );
      return { count: state.count + 1, fiber };
    }),
  );

  const releasePoller = SynchronizedRef.updateEffect(subscribersRef, (state) =>
    Effect.gen(function* () {
      const count = Math.max(0, state.count - 1);
      if (count > 0 || state.fiber === null) return { ...state, count };
      yield* Fiber.interrupt(state.fiber);
      return { count: 0, fiber: null };
    }),
  );

  const requireEnabled = Effect.gen(function* () {
    const settings = yield* hermesSettings;
    if (settings === null || !settings.enabled) {
      return yield* new HermesCronError({
        reason: "providerDisabled",
        detail: "The Hermes provider is not enabled in this environment.",
      });
    }
    return settings;
  });

  /**
   * Pause/resume goes through the CLI rather than editing `jobs.json`.
   *
   * Hermes takes a cross-process file lock around that file and self-heals
   * contradictory records; writing it from outside would race its scheduler
   * for no benefit. `pause`/`resume` are stable CLI verbs.
   */
  const setEnabled = (input: HermesCronSetEnabledInput) =>
    Effect.gen(function* () {
      const settings = yield* requireEnabled;
      const snapshot = yield* currentSnapshot;
      if (!snapshot.jobs.some((job) => job.id === input.jobId)) {
        return yield* new HermesCronError({
          reason: "unknownJob",
          detail: "That scheduled task no longer exists.",
        });
      }

      const binary = settings.binaryPath || "hermes";
      const args = ["cron", input.enabled ? "resume" : "pause", input.jobId];
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: process.env }).pipe(
        Effect.mapError(
          (cause) =>
            new HermesCronError({
              reason: "commandFailed",
              detail: "Could not run the hermes CLI.",
              cause,
            }),
        ),
      );
      const result = yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: process.env,
          shell: spawnCommand.shell,
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new HermesCronError({
              reason: "commandFailed",
              detail: `Could not ${input.enabled ? "resume" : "pause"} the task.`,
              cause,
            }),
        ),
      );
      if (result.code !== 0) {
        return yield* new HermesCronError({
          reason: "commandFailed",
          detail: `hermes cron ${input.enabled ? "resume" : "pause"} exited with code ${result.code}.`,
        });
      }

      // Re-read rather than patching the cached snapshot: Hermes may also have
      // cleared a pause marker or recomputed `next_run_at`.
      return yield* poll;
    });

  const setMuted = (input: HermesCronSetMutedInput) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const next = yield* Ref.updateAndGet(mutedRef, (muted) => {
        const updated = new Set(muted);
        if (input.muted) updated.add(input.jobId);
        else updated.delete(input.jobId);
        return updated;
      });
      yield* persistMuteState(next);
      // Mute is reflected on every job row, so the snapshot genuinely changed.
      return yield* poll;
    });

  const subscribe = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => releasePoller.pipe(Effect.ignore));
    yield* retainPoller;
    const subscription = yield* subscribeBeforeSnapshot(
      changes,
      Effect.map(
        currentSnapshot,
        (snapshot) => ({ _tag: "snapshot", snapshot }) satisfies HermesCronStreamEvent,
      ),
      subscribeMutex,
    );
    return Stream.concat(Stream.make(subscription.latest), subscription.changes);
  });

  return HermesCronService.of({
    list: (input) => (input.refresh === true ? poll : currentSnapshot),
    setEnabled,
    setMuted,
    subscribe,
  });
});

export const layer = Layer.effect(HermesCronService, make);

/** Empty service, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  HermesCronService,
  HermesCronService.of({
    list: () => Effect.succeed(emptySnapshot("1970-01-01T00:00:00.000Z", "providerDisabled")),
    setEnabled: () =>
      Effect.fail(
        new HermesCronError({ reason: "providerDisabled", detail: "Hermes is not enabled." }),
      ),
    setMuted: () =>
      Effect.fail(
        new HermesCronError({ reason: "providerDisabled", detail: "Hermes is not enabled." }),
      ),
    subscribe: Effect.succeed(Stream.empty),
  }),
);
