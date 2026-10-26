import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeHermesT3SubagentsOnly } from "./hermesSubagentsConfig.ts";

const withConfig = (contents: string | null) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-subagents-" });
    const configFile = path.join(dir, "config.yaml");
    if (contents !== null) yield* fileSystem.writeFileString(configFile, contents);
    const read = fileSystem.readFileString(configFile);
    const exists = fileSystem.exists(configFile);
    return { configFile, read, exists };
  });

describe("writeHermesT3SubagentsOnly", () => {
  it.effect("disables delegation and turning it off restores the original file", () =>
    Effect.gen(function* () {
      const original = "# mine\nmodel: gpt-6.1-sol\nagent:\n  max_turns: 80 # keep\n";
      const { configFile, read } = yield* withConfig(original);

      assert.deepStrictEqual(yield* writeHermesT3SubagentsOnly({ configFile, enabled: true }), {
        _tag: "written",
      });
      const on = yield* read;
      assert.include(on, "max_turns: 80 # keep");
      assert.match(on, /disabled_toolsets:\n\s+- delegation # managed by T3 Code/);
      assert.deepStrictEqual(yield* writeHermesT3SubagentsOnly({ configFile, enabled: true }), {
        _tag: "unchanged",
      });

      yield* writeHermesT3SubagentsOnly({ configFile, enabled: false });
      assert.strictEqual(yield* read, original);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never removes a delegation entry the user wrote", () =>
    Effect.gen(function* () {
      const original = "agent:\n  disabled_toolsets:\n    - web\n    - delegation\n";
      const { configFile, read } = yield* withConfig(original);

      assert.deepStrictEqual(yield* writeHermesT3SubagentsOnly({ configFile, enabled: true }), {
        _tag: "unchanged",
      });
      assert.deepStrictEqual(yield* writeHermesT3SubagentsOnly({ configFile, enabled: false }), {
        _tag: "unchanged",
      });
      assert.strictEqual(yield* read, original);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes its own entry after Hermes rewrites the file", () =>
    Effect.gen(function* () {
      // ruamel's spacing before the marker comment, next to a user entry.
      const { configFile, read } = yield* withConfig(
        "agent:\n  disabled_toolsets:\n  - web\n  - delegation  # managed by T3 Code (Use T3 Code subagents only)\n",
      );

      yield* writeHermesT3SubagentsOnly({ configFile, enabled: false });
      assert.strictEqual(yield* read, "agent:\n  disabled_toolsets:\n    - web\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves missing, unreadable, unparseable and string-valued configs alone", () =>
    Effect.gen(function* () {
      const missing = yield* withConfig(null);
      yield* writeHermesT3SubagentsOnly({ configFile: missing.configFile, enabled: false });
      assert.isFalse(yield* missing.exists);

      const broken = yield* withConfig("agent: [unclosed\n");
      const brokenOutcome = yield* writeHermesT3SubagentsOnly({
        configFile: broken.configFile,
        enabled: true,
      });
      assert.strictEqual(brokenOutcome._tag, "parseFailed");
      assert.strictEqual(yield* broken.read, "agent: [unclosed\n");

      const unreadable = yield* withConfig("model:\n  default: gpt-6.1-sol\n");
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.chmod(unreadable.configFile, 0o000);
      const unreadableOutcome = yield* writeHermesT3SubagentsOnly({
        configFile: unreadable.configFile,
        enabled: true,
      });
      yield* fileSystem.chmod(unreadable.configFile, 0o600);
      assert.strictEqual(unreadableOutcome._tag, "readFailed");
      assert.strictEqual(yield* unreadable.read, "model:\n  default: gpt-6.1-sol\n");

      const scalar = yield* withConfig("agent:\n  disabled_toolsets: web, memory\n");
      assert.deepStrictEqual(
        yield* writeHermesT3SubagentsOnly({ configFile: scalar.configFile, enabled: true }),
        { _tag: "unsupported" },
      );
      assert.strictEqual(yield* scalar.read, "agent:\n  disabled_toolsets: web, memory\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
