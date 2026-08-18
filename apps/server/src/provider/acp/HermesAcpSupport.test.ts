import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  hermesSessionInfoIndicatesCompaction,
  HERMES_BUILT_IN_SLASH_COMMANDS,
  resolveHermesAcpBaseModelId,
  resolveHermesSessionModeId,
} from "./HermesAcpSupport.ts";

describe("resolveHermesAcpBaseModelId", () => {
  it("falls back to the placeholder model for empty ids", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBe("hermes-4");
    expect(resolveHermesAcpBaseModelId("   ")).toBe("hermes-4");
  });

  it("passes provider-owned model ids through untouched", () => {
    expect(resolveHermesAcpBaseModelId("  openai/gpt-5  ")).toBe("openai/gpt-5");
    expect(resolveHermesAcpBaseModelId("NousResearch/Hermes-4-405B")).toBe(
      "NousResearch/Hermes-4-405B",
    );
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("launches the ACP stdio server and forwards the environment untouched", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes" },
      "/tmp/project",
      {
        HERMES_HOME: "/home/dev/.hermes",
      },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HERMES_HOME: "/home/dev/.hermes" },
    });
  });

  it("defaults to `hermes` on PATH and omits env when none is supplied", () => {
    expect(buildHermesAcpSpawnInput(null, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("resolveHermesSessionModeId", () => {
  const modeState = {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask", description: "Confirm every edit" },
      { id: "auto", name: "Auto", description: "Apply edits without asking" },
    ],
  };

  it("selects the autonomous mode for permissive runtime modes", () => {
    expect(resolveHermesSessionModeId({ runtimeMode: "full-access", modeState })).toBe("auto");
    expect(resolveHermesSessionModeId({ runtimeMode: "auto-accept-edits", modeState })).toBe(
      "auto",
    );
  });

  it("stays put when the requested mode is already active", () => {
    expect(
      resolveHermesSessionModeId({ runtimeMode: "approval-required", modeState }),
    ).toBeUndefined();
  });

  it("returns nothing when the agent advertises no usable modes", () => {
    expect(
      resolveHermesSessionModeId({ runtimeMode: "full-access", modeState: undefined }),
    ).toBeUndefined();
    expect(
      resolveHermesSessionModeId({
        runtimeMode: "full-access",
        modeState: { currentModeId: "only", availableModes: [] },
      }),
    ).toBeUndefined();
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "hermes-4",
        requestedModelId: "openai/gpt-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["openai/gpt-5"]);
      expect(result).toBe("openai/gpt-5");
    }),
  );

  it.effect("skips set_model when requested matches current or is absent", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: "hermes-4",
          mapError: (cause) => cause.message,
        }),
      ).toBe("hermes-4");
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: undefined,
          mapError: (cause) => cause.message,
        }),
      ).toBe("hermes-4");
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("re-sends the current model when forceReapply asks for an agent rebuild", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      // Hermes rebuilds the session's agent from config.yaml on every
      // set_session_model, which is the only way a reasoning level reaches a
      // session that is already running.
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai/gpt-5",
          requestedModelId: "openai/gpt-5",
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBe("openai/gpt-5");
      // No requested model still rebuilds, using whatever the session is on.
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai/gpt-5",
          requestedModelId: undefined,
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBe("openai/gpt-5");
      expect(modelCalls).toEqual(["openai/gpt-5", "openai/gpt-5"]);
    }),
  );

  it.effect("has nothing to re-send when forceReapply hits a session with no model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: undefined,
          requestedModelId: undefined,
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBeUndefined();
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model id");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: "openai/gpt-5",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("HERMES_BUILT_IN_SLASH_COMMANDS", () => {
  it("mirrors the ACP adapter's advertised command names", () => {
    // Source of truth: `_ADVERTISED_COMMANDS` in hermes-agent's
    // `acp_adapter/server.py`. These are the adapter's commands, not the
    // interactive `hermes` TUI's.
    expect(HERMES_BUILT_IN_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "model",
      "tools",
      "context",
      "reset",
      "compress",
      "steer",
      "queue",
      "version",
    ]);
  });

  it("gives every seeded command a description and only hints the ones that take input", () => {
    for (const command of HERMES_BUILT_IN_SLASH_COMMANDS) {
      expect(command.description).toBeTruthy();
    }
    expect(
      HERMES_BUILT_IN_SLASH_COMMANDS.filter((command) => command.input !== undefined).map(
        (command) => command.name,
      ),
    ).toEqual(["model", "steer", "queue"]);
  });
});

describe("hermesSessionInfoIndicatesCompaction", () => {
  it("detects a compression-driven session rotation", () => {
    expect(
      hermesSessionInfoIndicatesCompaction({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          title: "Long thread",
          _meta: {
            hermes: {
              sessionProvenance: {
                compressionDepth: 2,
                reason: "compression",
                creatorKind: "compression",
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("ignores provenance without a compression reason", () => {
    expect(
      hermesSessionInfoIndicatesCompaction({
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { hermes: { sessionProvenance: { compressionDepth: 0 } } },
        },
      }),
    ).toBe(false);
  });

  it("ignores payloads with no Hermes provenance at all", () => {
    expect(hermesSessionInfoIndicatesCompaction(undefined)).toBe(false);
    expect(hermesSessionInfoIndicatesCompaction({ update: { title: "x" } })).toBe(false);
    expect(hermesSessionInfoIndicatesCompaction({ _meta: { hermes: {} } })).toBe(false);
  });
});
