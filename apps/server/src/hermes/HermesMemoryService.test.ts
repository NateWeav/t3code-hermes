import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type HermesMemorySnapshot,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PubSub, Queue, Ref, Stream } from "effect";

import * as ServerSettings from "../serverSettings.ts";
import * as Memory from "./HermesMemoryService.ts";

const withHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-memory-service-" });
  const directory = path.join(home, "memories");
  const memoryPath = path.join(directory, "MEMORY.md");
  return { fs, path, home, directory, memoryPath };
});

function enabledSettings(home: string): Settings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      hermes: {
        driver: "hermes",
        config: { enabled: true, binaryPath: "hermes" },
        environment: [{ name: "HERMES_HOME", value: home }],
      },
    },
  } as Settings;
}

const watch = Effect.gen(function* () {
  const service = yield* Memory.HermesMemoryService;
  const seen = yield* Queue.unbounded<HermesMemorySnapshot>();
  const stream = yield* service.subscribe;
  yield* Stream.runForEach(stream, (snapshot) => Queue.offer(seen, snapshot)).pipe(
    Effect.forkScoped,
  );
  return { service, seen };
});

describe("HermesMemoryService", () => {
  it.live(
    "emits an initial snapshot then atomic external changes, including creation of a missing store",
    () =>
      Effect.gen(function* () {
        const { fs, path, home, directory, memoryPath } = yield* withHome;
        yield* Effect.gen(function* () {
          const { service, seen } = yield* watch;
          const initial = yield* Queue.take(seen);
          assert.equal(initial.availability, "ready");
          assert.deepEqual(
            initial.files.map((file) => file.entries),
            [[], []],
          );
          assert.isFalse(yield* fs.exists(directory)); // reads never initialize the user's store
          yield* fs.makeDirectory(directory);
          const staging = path.join(directory, "staged");
          yield* fs.writeFileString(staging, "Remember this\n§\nAnd this");
          yield* fs.rename(staging, memoryPath);
          const changed = yield* Queue.take(seen);
          assert.deepEqual(changed.files[0]?.entries, ["Remember this", "And this"]);
          // A fresh read of identical state publishes nothing.
          yield* service.read;
          assert.equal(yield* Queue.size(seen), 0);
          yield* fs.writeFileString(staging, "A replacement from Hermes");
          yield* fs.rename(staging, memoryPath);
          assert.deepEqual((yield* Queue.take(seen)).files[0]?.entries, [
            "A replacement from Hermes",
          ]);
          yield* fs.remove(memoryPath);
          assert.deepEqual((yield* Queue.take(seen)).files[0]?.entries, []);
        }).pipe(
          Effect.provide(
            Memory.layer.pipe(Layer.provide(ServerSettings.layerTest(enabledSettings(home)))),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("publishes mutation receipts to every subscriber and rejects stale writes", () =>
    Effect.gen(function* () {
      const { home } = yield* withHome;
      yield* Effect.gen(function* () {
        const first = yield* watch;
        const second = yield* watch;
        const initial = yield* Queue.take(first.seen);
        yield* Queue.take(second.seen);
        const file = initial.files[0]!;
        const saved = yield* first.service.mutate({
          target: "memory",
          action: "add",
          revision: file.revision,
          content: "A saved note",
        });
        assert.deepEqual(saved.files[0]?.entries, ["A saved note"]);
        assert.deepEqual((yield* Queue.take(first.seen)).files[0]?.entries, ["A saved note"]);
        assert.deepEqual((yield* Queue.take(second.seen)).files[0]?.entries, ["A saved note"]);
        const conflict = yield* first.service
          .mutate({
            target: "memory",
            action: "add",
            revision: file.revision,
            content: "Stale note",
          })
          .pipe(Effect.flip);
        assert.equal(conflict.reason, "conflict");
      }).pipe(
        Effect.provide(
          Memory.layer.pipe(Layer.provide(ServerSettings.layerTest(enabledSettings(home)))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("watches character-limit changes and isolates an unreadable file", () =>
    Effect.gen(function* () {
      const { fs, path, home, directory, memoryPath } = yield* withHome;
      yield* fs.makeDirectory(directory);
      yield* fs.writeFile(memoryPath, new Uint8Array([255, 254]));
      yield* fs.writeFileString(path.join(directory, "USER.md"), "Valid user profile");
      yield* Effect.gen(function* () {
        const { seen } = yield* watch;
        const first = yield* Queue.take(seen);
        assert.equal(first.availability, "ready");
        assert.isNotNull(first.files[0]?.error);
        assert.isNull(first.files[1]?.error);
        yield* fs.writeFileString(
          path.join(home, "config.tmp"),
          "memory:\n  user_char_limit: 2000\n",
        );
        yield* fs.rename(path.join(home, "config.tmp"), path.join(home, "config.yaml"));
        assert.equal((yield* Queue.take(seen)).files[1]?.charLimit, 2000);
      }).pipe(
        Effect.provide(
          Memory.layer.pipe(Layer.provide(ServerSettings.layerTest(enabledSettings(home)))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("retargets the instance home and becomes inert when the provider is disabled", () =>
    Effect.gen(function* () {
      const { fs, path, home } = yield* withHome;
      const other = path.join(home, "other");
      yield* fs.makeDirectory(path.join(other, "memories"), { recursive: true });
      yield* fs.writeFileString(path.join(other, "memories/USER.md"), "Other profile");
      const state = yield* Ref.make(enabledSettings(home));
      const updates = yield* PubSub.unbounded<Settings>();
      const base = yield* ServerSettings.ServerSettingsService;
      const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
        ...base,
        getSettings: Ref.get(state),
        subscribeChanges: Effect.map(PubSub.subscribe(updates), Stream.fromSubscription),
      });
      const change = (settings: Settings) =>
        Ref.set(state, settings).pipe(Effect.andThen(PubSub.publish(updates, settings)));
      yield* Effect.gen(function* () {
        const { service, seen } = yield* watch;
        yield* Queue.take(seen);
        yield* change(enabledSettings(other));
        assert.deepEqual((yield* Queue.take(seen)).files[1]?.entries, ["Other profile"]);
        yield* change(DEFAULT_SERVER_SETTINGS);
        assert.equal((yield* Queue.take(seen)).availability, "providerDisabled");
        const failure = yield* service
          .mutate({ target: "memory", action: "add", revision: "missing", content: "No write" })
          .pipe(Effect.flip);
        assert.equal(failure.reason, "providerDisabled");
        assert.isFalse(yield* fs.exists(path.join(home, "memories")));
      }).pipe(Effect.provide(Memory.layer.pipe(Layer.provide(settingsLayer))));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(ServerSettings.layerTest(), NodeServices.layer)),
    ),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "watches readable stores even when their parent cannot be watched",
    () =>
      Effect.gen(function* () {
        const { fs, path, home } = yield* withHome;
        const parent = path.join(home, "traverse-only");
        const selected = path.join(parent, "profile");
        const memories = path.join(selected, "memories");
        yield* fs.makeDirectory(memories, { recursive: true });
        yield* fs.chmod(parent, 0o111);
        yield* Effect.gen(function* () {
          const { seen } = yield* watch;
          yield* Queue.take(seen);
          yield* fs.writeFileString(path.join(memories, "stage"), "Still watched");
          yield* fs.rename(path.join(memories, "stage"), path.join(memories, "MEMORY.md"));
          assert.deepEqual((yield* Queue.take(seen)).files[0]?.entries, ["Still watched"]);
        }).pipe(
          Effect.provide(
            Memory.layer.pipe(Layer.provide(ServerSettings.layerTest(enabledSettings(selected)))),
          ),
          Effect.ensuring(fs.chmod(parent, 0o700).pipe(Effect.orDie)),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refreshes the initial snapshot after all clients disconnect", () =>
    Effect.gen(function* () {
      const { fs, home, directory, memoryPath } = yield* withHome;
      yield* Effect.gen(function* () {
        const service = yield* Memory.HermesMemoryService;
        const first = yield* Effect.scoped(Effect.flatMap(service.subscribe, Stream.runHead));
        assert.equal(first._tag, "Some");
        yield* fs.makeDirectory(directory);
        yield* fs.writeFileString(memoryPath, "Changed while closed");
        const second = yield* Effect.scoped(Effect.flatMap(service.subscribe, Stream.runHead));
        assert.equal(second._tag, "Some");
        if (second._tag === "Some")
          assert.deepEqual(second.value.files[0]?.entries, ["Changed while closed"]);
      }).pipe(
        Effect.provide(
          Memory.layer.pipe(Layer.provide(ServerSettings.layerTest(enabledSettings(home)))),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
