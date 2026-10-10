/** One compact snapshot per environment; file contents are fetched only on demand. */
import {
  HERMES_SKILLS_CONTRACT_VERSION,
  HermesSkillsError,
  type HermesSkillDetail,
  type HermesSkillsGetInput,
  HermesSkillsSnapshot,
  type HermesSkillsStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";
import { resolveEnabledHermesInstance } from "./hermesCronState.ts";
import {
  readHermesSkillDetail,
  readHermesSkills,
  resolveHermesSkillsPath,
} from "./hermesSkillsState.ts";

export class HermesSkillsService extends Context.Service<
  HermesSkillsService,
  {
    readonly list: (input: {
      readonly refresh?: boolean;
    }) => Effect.Effect<HermesSkillsSnapshot, HermesSkillsError>;
    readonly get: (
      input: HermesSkillsGetInput,
    ) => Effect.Effect<HermesSkillDetail, HermesSkillsError>;
    readonly subscribe: Effect.Effect<
      Stream.Stream<HermesSkillsStreamEvent>,
      HermesSkillsError,
      Scope.Scope
    >;
  }
>()("t3-hermes/hermes/HermesSkillsService") {}

const sameSnapshot = Schema.toEquivalence(HermesSkillsSnapshot);

const emptySnapshot = (readAt: string): HermesSkillsSnapshot => ({
  contractVersion: HERMES_SKILLS_CONTRACT_VERSION,
  readAt,
  revision: 0,
  availability: "providerDisabled",
  detail: null,
  skills: [],
  truncated: false,
});

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<HermesSkillsStreamEvent>(1),
    PubSub.shutdown,
  );
  const mutex = yield* Semaphore.make(1);
  const snapshotRef = yield* Ref.make<HermesSkillsSnapshot | null>(null);
  const rootRef = yield* Ref.make<string | null>(null);
  const watcherScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const subscribers = yield* SynchronizedRef.make<{
    readonly count: number;
    readonly fiber: Fiber.Fiber<void> | null;
  }>({ count: 0, fiber: null });

  const skillsPath = settings.getSettings.pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* (value) {
        const instance = resolveEnabledHermesInstance(value);
        return instance === null
          ? null
          : resolveHermesSkillsPath(yield* mergeProviderInstanceEnvironment(instance.environment));
      }),
    ),
    Effect.mapError(
      (cause) =>
        new HermesSkillsError({
          reason: "unreadable",
          detail: "Hermes settings could not be read.",
          cause,
        }),
    ),
  );
  // `undefined` marks unreadable settings, which must not look like a disabled instance (`null`).
  const knownSkillsPath = skillsPath.pipe(
    Effect.catchTags({
      HermesSkillsError: (error) =>
        Effect.logWarning("Hermes skills could not read server settings", error).pipe(
          Effect.as(undefined),
        ),
    }),
  );

  const readSnapshot = Effect.gen(function* () {
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const root = yield* knownSkillsPath;
    if (root === undefined) {
      return {
        root: null,
        snapshot: {
          ...emptySnapshot(readAt),
          availability: "unreadable" as const,
          detail: "Hermes settings could not be read.",
        },
      };
    }
    if (root === null) return { root, snapshot: emptySnapshot(readAt) };
    const state = yield* Effect.promise(() => readHermesSkills(root));
    return {
      root,
      snapshot: { ...state, contractVersion: HERMES_SKILLS_CONTRACT_VERSION, readAt, revision: 0 },
    };
  });

  // Writers and snapshot subscription share the lock so initial state cannot race a publish.
  const refreshLocked = Effect.gen(function* () {
    const result = yield* readSnapshot;
    const previous = yield* Ref.get(snapshotRef);
    const previousRoot = yield* Ref.get(rootRef);
    const changed =
      previous === null ||
      result.root !== previousRoot ||
      !sameSnapshot(
        { ...result.snapshot, readAt: previous.readAt, revision: previous.revision },
        previous,
      );
    const snapshot = {
      ...result.snapshot,
      revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
    };
    yield* Ref.set(rootRef, result.root);
    yield* Ref.set(snapshotRef, snapshot);
    if (changed) {
      yield* PubSub.publish(changes, {
        _tag: "snapshot",
        snapshot,
      } satisfies HermesSkillsStreamEvent);
    }
    return snapshot;
  });
  const refresh = mutex.withPermits(1)(refreshLocked);

  // A periodic read recovers from dropped OS events and missing/replaced directories.
  // It runs only while subscribed and enabled; normal edits arrive through the watcher.
  const observe = Stream.unwrap(
    Effect.gen(function* () {
      const settingsChanges = yield* settings.subscribeChanges;
      return Stream.concat(Stream.make(undefined), settingsChanges).pipe(
        Stream.mapEffect(() => knownSkillsPath),
        Stream.changes,
        Stream.switchMap((root) => {
          if (root === null || root === undefined) return Stream.fromEffect(refresh);
          const watch = fs
            .watch(root, { recursive: true })
            .pipe(
              Stream.retry(Schedule.spaced(Duration.seconds(60))),
              Stream.debounce(Duration.millis(150)),
            );
          const fallback = Stream.fromEffectSchedule(
            Effect.void,
            Schedule.spaced(Duration.seconds(60)),
          );
          return Stream.merge(watch, fallback).pipe(Stream.mapEffect(() => refresh));
        }),
      );
    }),
  );

  const retain = SynchronizedRef.updateEffect(subscribers, (state) =>
    Effect.gen(function* () {
      if (state.fiber !== null) return { ...state, count: state.count + 1 };
      const fiber = yield* Stream.runDrain(observe).pipe(
        Effect.ignore,
        Effect.forkIn(watcherScope),
      );
      return { count: 1, fiber };
    }),
  );
  const release = SynchronizedRef.updateEffect(subscribers, (state) =>
    Effect.gen(function* () {
      const count = Math.max(0, state.count - 1);
      if (count > 0 || state.fiber === null) return { ...state, count };
      yield* Fiber.interrupt(state.fiber);
      return { count: 0, fiber: null };
    }),
  );

  return HermesSkillsService.of({
    list: (input) =>
      input.refresh
        ? refresh
        : Effect.gen(function* () {
            const cached = yield* Ref.get(snapshotRef);
            return cached ?? (yield* refresh);
          }),
    get: Effect.fn("HermesSkillsService.get")(function* (input) {
      const root = yield* skillsPath;
      if (root === null)
        return yield* new HermesSkillsError({
          reason: "providerDisabled",
          detail: "Hermes is not enabled in this environment.",
        });
      return yield* Effect.tryPromise({
        try: () => readHermesSkillDetail(root, input.path),
        catch: (cause) =>
          new HermesSkillsError({
            reason: "unknownSkill",
            detail: "This skill is no longer available or could not be read.",
            cause,
          }),
      });
    }),
    subscribe: Effect.gen(function* () {
      yield* Effect.acquireRelease(retain, () => release);
      const subscription = yield* subscribeBeforeSnapshot(
        changes,
        refreshLocked.pipe(
          Effect.map((snapshot): HermesSkillsStreamEvent => ({ _tag: "snapshot", snapshot })),
        ),
        mutex,
      );
      return Stream.concat(Stream.make(subscription.latest), subscription.changes);
    }),
  });
});

export const layer = Layer.effect(HermesSkillsService, make);
