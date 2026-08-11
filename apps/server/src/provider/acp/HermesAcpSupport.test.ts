import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
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
