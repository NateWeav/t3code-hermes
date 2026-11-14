import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parseDocument } from "yaml";

import {
  disableHermesSessionResetPlugin,
  enableHermesSessionResetPlugin,
  markSessionResetPlugin,
  unmarkSessionResetPlugin,
} from "./hermesSessionResetConfig.ts";

const PLUGIN = "hermes-session-reset-policy";

const enabledPlugins = (text: string): unknown =>
  (parseDocument(text).toJS() as { plugins?: { enabled?: unknown } }).plugins?.enabled;

const withConfig = <A, E, R>(
  text: string,
  body: (configFile: string, fileSystem: FileSystem.FileSystem) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-session-reset-" });
    const configFile = path.join(dir, "config.yaml");
    yield* fileSystem.writeFileString(configFile, text);
    return yield* body(configFile, fileSystem);
  }).pipe(Effect.scoped);

describe("hermesSessionResetConfig", () => {
  it("adds a marked entry to a config with no plugins block, and removal takes it back", () => {
    const original = "# Hermes config\nsession_reset:\n  mode: both # keep\n";
    const document = parseDocument(original);
    assert.equal(markSessionResetPlugin(document), 1);
    const marked = document.toString();
    assert.deepEqual(enabledPlugins(marked), [PLUGIN]);
    assert.include(marked, "# added by T3 Code");
    assert.include(marked, "mode: both # keep");
    assert.equal(markSessionResetPlugin(document), 0);

    const reread = parseDocument(marked);
    assert.equal(unmarkSessionResetPlugin(reread), 1);
    assert.equal(enabledPlugins(reread.toString()), undefined);
    assert.include(reread.toString(), "mode: both # keep");
  });

  it("joins an existing enabled list and leaves the user's entries in place", () => {
    const document = parseDocument("plugins:\n  enabled: [hindsight]\n  disabled: []\n");
    assert.equal(markSessionResetPlugin(document), 1);
    assert.deepEqual(enabledPlugins(document.toString()), ["hindsight", PLUGIN]);
    assert.equal(unmarkSessionResetPlugin(document), 1);
    assert.deepEqual(enabledPlugins(document.toString()), ["hindsight"]);
  });

  it("stands aside when the user already enabled or disabled the plugin", () => {
    const userEnabled = parseDocument(`plugins:\n  enabled:\n    - ${PLUGIN}\n`);
    assert.equal(markSessionResetPlugin(userEnabled), 0);
    assert.equal(unmarkSessionResetPlugin(userEnabled), 0);
    assert.deepEqual(enabledPlugins(userEnabled.toString()), [PLUGIN]);

    const userDisabled = parseDocument(`plugins:\n  disabled:\n    - ${PLUGIN}\n`);
    assert.equal(markSessionResetPlugin(userDisabled), 0);
    assert.equal(enabledPlugins(userDisabled.toString()), undefined);
  });

  it("leaves a plugins block of an unexpected shape alone", () => {
    assert.equal(markSessionResetPlugin(parseDocument("plugins: none\n")), 0);
    assert.equal(markSessionResetPlugin(parseDocument("plugins:\n  enabled: all\n")), 0);
  });

  it.effect("writes the config through apply and remove, and skips an unparseable one", () =>
    Effect.gen(function* () {
      yield* withConfig("model:\n  default: gpt-5.5\n", (configFile, fileSystem) =>
        Effect.gen(function* () {
          assert.equal(yield* enableHermesSessionResetPlugin(configFile), 1);
          assert.deepEqual(enabledPlugins(yield* fileSystem.readFileString(configFile)), [PLUGIN]);
          assert.equal(yield* disableHermesSessionResetPlugin(configFile), 1);
          assert.equal(enabledPlugins(yield* fileSystem.readFileString(configFile)), undefined);
        }),
      );
      const broken = "model: [unclosed\n";
      yield* withConfig(broken, (configFile, fileSystem) =>
        Effect.gen(function* () {
          assert.equal(yield* enableHermesSessionResetPlugin(configFile), 0);
          assert.equal(yield* fileSystem.readFileString(configFile), broken);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
