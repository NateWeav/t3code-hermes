// @effect-diagnostics nodeBuiltinImport:off - stands up throwaway HTTP servers for endpoint detection.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import { parseDocument } from "yaml";

import {
  markFastModeEndpoints,
  optInHermesFastModeEndpoints,
  optOutHermesFastModeEndpoints,
  unmarkFastModeEndpoints,
} from "./hermesFastModeConfig.ts";

/** An HTTP server answering its root with `body`, closed with the scope. */
const serveRoot = (body: unknown) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.map((server) => `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/v1`),
  );

const CONFIG = `# Hermes config
model:
  default: gpt-5.5
custom_providers:
  - name: cliproxyapi # my proxy
    base_url: BASE_A
    models:
      gpt-5.5: {}
  - name: litellm
    base_url: BASE_B
  - name: pinned
    base_url: BASE_A
    capabilities:
      fast_mode: false
providers:
  keyed:
    api: BASE_A
    capabilities: {openai_native_compaction: true}
`;

const fastModeFlags = (text: string) => {
  const config = parseDocument(text).toJS() as {
    readonly custom_providers: ReadonlyArray<{ readonly capabilities?: { fast_mode?: boolean } }>;
    readonly providers: Record<string, { readonly capabilities?: { fast_mode?: boolean } }>;
  };
  return [
    ...config.custom_providers.map((entry) => entry.capabilities?.fast_mode),
    ...Object.values(config.providers).map((entry) => entry.capabilities?.fast_mode),
  ];
};

describe("hermesFastModeConfig", () => {
  it("marks accepted endpoints, keeps the user's own flags, and unmarks only its own", () => {
    const original = CONFIG.replaceAll("BASE_A", "http://a/v1").replaceAll("BASE_B", "http://b/v1");
    const document = parseDocument(original);

    assert.equal(
      markFastModeEndpoints(document, (url) => url === "http://a/v1"),
      2,
    );
    const marked = document.toString();
    assert.deepEqual(fastModeFlags(marked), [true, undefined, false, true]);
    assert.include(marked, "# my proxy");
    assert.include(marked, "openai_native_compaction: true");

    const reparsed = parseDocument(marked);
    assert.equal(unmarkFastModeEndpoints(reparsed), 2);
    assert.deepEqual(fastModeFlags(reparsed.toString()), [undefined, undefined, false, undefined]);
    // A flag the user wrote by hand is never T3 Code's to remove.
    const handWritten = parseDocument(original.replace("fast_mode: false", "fast_mode: true"));
    assert.equal(unmarkFastModeEndpoints(handWritten), 0);
  });

  it.effect("opts in only endpoints that identify as CLIProxyAPI, and opts back out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const proxy = yield* serveRoot({
        endpoints: ["POST /v1/chat/completions"],
        message: "CLI Proxy API Server",
      });
      const other = yield* serveRoot({ status: "ok" });
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-fast-" });
      const configFile = path.join(dir, "config.yaml");
      const original = CONFIG.replaceAll("BASE_A", proxy).replaceAll("BASE_B", other);
      yield* fileSystem.writeFileString(configFile, original);

      assert.equal(yield* optInHermesFastModeEndpoints(configFile), 2);
      assert.deepEqual(fastModeFlags(yield* fileSystem.readFileString(configFile)), [
        true,
        undefined,
        false,
        true,
      ]);
      // Applying again finds nothing left to opt in.
      assert.equal(yield* optInHermesFastModeEndpoints(configFile), 0);

      assert.equal(yield* optOutHermesFastModeEndpoints(configFile), 2);
      assert.deepEqual(fastModeFlags(yield* fileSystem.readFileString(configFile)), [
        undefined,
        undefined,
        false,
        undefined,
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  );

  it.effect("leaves a config it cannot parse untouched", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-hermes-fast-" });
      const configFile = path.join(dir, "config.yaml");
      const broken = "custom_providers:\n  - name: x\n    base_url: [unclosed\n";
      yield* fileSystem.writeFileString(configFile, broken);

      assert.equal(yield* optInHermesFastModeEndpoints(configFile), 0);
      assert.equal(yield* fileSystem.readFileString(configFile), broken);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer))),
  );
});
