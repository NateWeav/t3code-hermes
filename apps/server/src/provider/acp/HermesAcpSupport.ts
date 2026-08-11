/**
 * HermesAcpSupport — spawn, model, and mode helpers for the Hermes Agent
 * ACP stdio server (`hermes acp`).
 *
 * Hermes reads its credentials from its own `HERMES_HOME` (`~/.hermes/.env`),
 * so unlike Grok there is no API-key-vs-cached-token branch here: the
 * `authenticate` method id is a constant and the agent resolves the rest.
 *
 * @module provider/acp/HermesAcpSupport
 */
import { type HermesSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
/** Hermes authenticates from `~/.hermes/.env`; the method id is a formality. */
const HERMES_AUTH_METHOD_ID = "hermes";
export const HERMES_FALLBACK_MODEL_ID = "hermes-4";

/**
 * Mode ids Hermes derives from its edit-approval policy. Matching is by id,
 * name, then substring, so builds that rename a policy still resolve.
 */
const HERMES_AUTONOMOUS_MODE_ALIASES = [
  "auto",
  "autonomous",
  "auto approve",
  "yolo",
  "full access",
  "accept edits",
  "bypass",
];
const HERMES_APPROVAL_MODE_ALIASES = ["ask", "approve", "manual", "confirm", "default"];

type HermesAcpRuntimeHermesSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveHermesAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : HERMES_FALLBACK_MODEL_ID;
  return normalizeModelSlug(base, HERMES_DRIVER_KIND) ?? HERMES_FALLBACK_MODEL_ID;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

function findModeIdByAliases(
  modes: ReadonlyArray<AcpSessionModeState["availableModes"][number]>,
  aliases: ReadonlyArray<string>,
): string | undefined {
  const searchText = (mode: (typeof modes)[number]) =>
    [mode.id, mode.name, mode.description]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(" ")
      .toLowerCase();

  for (const alias of aliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) return exact.id;
  }
  for (const alias of aliases) {
    const partial = modes.find((mode) => searchText(mode).includes(alias));
    if (partial) return partial.id;
  }
  return undefined;
}

/**
 * Pick the Hermes session mode that matches the thread's runtime mode.
 * Returns `undefined` when the agent advertises no modes, or when the mode
 * it already runs is the best match — callers then skip `session/set_mode`.
 */
export function resolveHermesSessionModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState || modeState.availableModes.length === 0) {
    return undefined;
  }
  const aliases =
    input.runtimeMode === "approval-required"
      ? HERMES_APPROVAL_MODE_ALIASES
      : HERMES_AUTONOMOUS_MODE_ALIASES;
  const requestedModeId = findModeIdByAliases(modeState.availableModes, aliases);
  return requestedModeId === undefined || requestedModeId === modeState.currentModeId
    ? undefined
    : requestedModeId;
}
