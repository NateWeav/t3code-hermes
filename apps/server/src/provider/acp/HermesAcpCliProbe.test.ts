/**
 * Optional integration check against a real `hermes acp` install.
 * Enable with: T3_HERMES_ACP_PROBE=1 bun run test HermesAcpCliProbe
 *
 * Hermes reads its credentials from `~/.hermes/.env` (or `HERMES_HOME`), so
 * the probe needs a configured Hermes install rather than any T3-side env.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeHermesAcpRuntime } from "./HermesAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeHermesAcpRuntime({
    hermesSettings: { binaryPath: "hermes" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-hermes-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_HERMES_ACP_PROBE === "1")("Hermes ACP CLI probe", () => {
  it.effect("initialize advertises load_session support", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(started.initializeResult.agentCapabilities?.loadSession).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises a model picker built from the Hermes provider config", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();

      expect(typeof started.sessionId).toBe("string");
      const models = started.sessionSetupResult.models;
      expect(models).toBeDefined();
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
