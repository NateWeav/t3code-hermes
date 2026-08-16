// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PROVIDER_QUOTA_CONTRACT_VERSION,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderQuotaAccount,
  ProviderQuotaReadError,
  type ProviderQuotaSummary,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readCodexAccountQuota } from "../provider/Layers/CodexProvider.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  parseClaudeUsage,
  parseCodexRateLimits,
  parseOpenCodeGoDocument,
  parseOpenCodeGoUsage,
} from "./providerQuotaReaders.ts";
import {
  parseClaudeNativeCredentialsText,
  readClaudeNativeCredentialsFile,
  readOpenCodeGoApiKey,
  readOpenCodeGoLocalQuota,
  type ClaudeNativeCredentials,
} from "./providerQuotaLocal.ts";

const REQUEST_TIMEOUT_MS = 10_000;

export class ProviderQuotaService extends Context.Service<
  ProviderQuotaService,
  {
    readonly read: Effect.Effect<ProviderQuotaSummary, ProviderQuotaReadError>;
  }
>()("t3/providerQuota/ProviderQuotaService") {}

const decodeCodexSettings = Schema.decodeUnknownEffect(
  Schema.Struct({
    binaryPath: Schema.String,
    homePath: Schema.String,
    launchArgs: Schema.String,
  }),
);
const decodeClaudeSettings = Schema.decodeUnknownEffect(
  Schema.Struct({ binaryPath: Schema.String, homePath: Schema.String }),
);
const decodeOpenCodeSettings = Schema.decodeUnknownEffect(
  Schema.Struct({ binaryPath: Schema.String }),
);

function environmentFor(instance: ProviderInstanceConfig): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of instance.environment ?? []) {
    if (entry.valueRedacted === true) continue;
    environment[entry.name] = entry.value;
  }
  return environment;
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const value = error.message.replaceAll(/\s+/g, " ").trim();
  return value.length === 0 ? fallback : value.slice(0, 240);
}

function displayName(instance: ProviderInstanceConfig, fallback: string): string {
  return instance.displayName?.trim() || fallback;
}

function codexAccountLabel(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const account = (value as { account?: unknown }).account;
  if (typeof account !== "object" || account === null) return null;
  const email = (account as { email?: unknown }).email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

const decodeClaudeAuthStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      loggedIn: Schema.Boolean,
      email: Schema.optional(Schema.String),
      subscriptionType: Schema.optional(Schema.String),
    }),
  ),
);

const configuredValue = (
  name: string,
  instanceEnvironment: NodeJS.ProcessEnv,
): string | undefined =>
  instanceEnvironment[name]?.trim() || process.env[name]?.trim() || undefined;

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const lastGood = new Map<ProviderInstanceId, ProviderQuotaAccount>();

  const readClaudeDocument = Effect.fn("ProviderQuotaService.readClaudeDocument")(function* (
    accessToken: string,
  ) {
    const request = HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage").pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
      HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
      HttpClientRequest.setHeader("user-agent", "claude-code/2.1.0"),
    );
    return yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(REQUEST_TIMEOUT_MS),
    );
  });

  const readOpenCodeDocument = Effect.fn("ProviderQuotaService.readOpenCodeDocument")(function* (
    workspaceId: string,
    cookie: string,
    nowMs: number,
  ) {
    const request = HttpClientRequest.get(`https://opencode.ai/workspace/${workspaceId}/go`).pipe(
      HttpClientRequest.setHeader("accept", "text/html,application/json"),
      HttpClientRequest.setHeader("cookie", cookie),
      HttpClientRequest.setHeader("user-agent", "Mozilla/5.0 T3Code/1.0"),
    );
    const text = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(REQUEST_TIMEOUT_MS),
    );
    const document = parseOpenCodeGoDocument(text, nowMs);
    if (document === null)
      return yield* new ProviderQuotaReadError({
        detail: "OpenCode Go did not return recognizable quota windows.",
      });
    return document;
  });

  const readOpenCodeApiUsage = Effect.fn("ProviderQuotaService.readOpenCodeApiUsage")(function* (
    apiKey: string,
  ) {
    const request = HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
      HttpClientRequest.setHeader("user-agent", "T3Code/1.0"),
    );
    return yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(REQUEST_TIMEOUT_MS),
    );
  });

  const readCodex = Effect.fn("ProviderQuotaService.readCodex")(function* (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    observedAt: string,
  ) {
    const decoded = yield* decodeCodexSettings(instance.config).pipe(Effect.option);
    if (decoded._tag === "None") {
      return {
        providerInstanceId: instanceId,
        provider: instance.driver,
        displayName: displayName(instance, "Codex"),
        accountLabel: null,
        planLabel: null,
        source: null,
        status: "unavailable",
        windows: [],
        observedAt,
        message: "This Codex instance has invalid settings.",
      } satisfies ProviderQuotaAccount;
    }
    const result = yield* Effect.result(
      readCodexAccountQuota({
        binaryPath: decoded.value.binaryPath,
        homePath: decoded.value.homePath,
        launchArgs: decoded.value.launchArgs,
        cwd: process.cwd(),
        environment: environmentFor(instance),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.scoped,
      ),
    );
    if (Result.isFailure(result)) {
      const cached = lastGood.get(instanceId);
      return {
        ...(cached ?? {
          providerInstanceId: instanceId,
          provider: instance.driver,
          displayName: displayName(instance, "Codex"),
          accountLabel: null,
          planLabel: null,
          source: "cli" as const,
          windows: [],
          observedAt,
        }),
        status: "failed" as const,
        message: errorMessage(result.failure, "Codex limits could not be read."),
      } satisfies ProviderQuotaAccount;
    }
    const parsed = parseCodexRateLimits(result.success.rateLimits);
    const account = {
      providerInstanceId: instanceId,
      provider: instance.driver,
      displayName: displayName(instance, "Codex"),
      accountLabel: codexAccountLabel(result.success.account),
      planLabel: parsed.planLabel,
      source: "cli",
      status: parsed.windows.length > 0 ? "ok" : "unavailable",
      windows: parsed.windows,
      observedAt,
      message:
        parsed.windows.length > 0
          ? null
          : "Codex did not report subscription limits for this account.",
    } satisfies ProviderQuotaAccount;
    if (account.status === "ok") lastGood.set(instanceId, account);
    return account;
  });

  const readClaude = Effect.fn("ProviderQuotaService.readClaude")(function* (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    observedAt: string,
  ) {
    const decoded = yield* decodeClaudeSettings(instance.config).pipe(Effect.option);
    if (decoded._tag === "None") {
      return {
        providerInstanceId: instanceId,
        provider: instance.driver,
        displayName: displayName(instance, "Claude"),
        accountLabel: null,
        planLabel: null,
        source: null,
        status: "unavailable",
        windows: [],
        observedAt,
        message: "This Claude instance has invalid settings.",
      } satisfies ProviderQuotaAccount;
    }
    const instanceEnvironment = environmentFor(instance);
    const explicitToken = configuredValue("CLAUDE_CODE_OAUTH_TOKEN", instanceEnvironment);
    const claudeEnvironment: NodeJS.ProcessEnv = { ...process.env, ...instanceEnvironment };
    if (decoded.value.homePath.trim()) {
      claudeEnvironment.CLAUDE_CONFIG_DIR = NodePath.resolve(
        expandHomePath(decoded.value.homePath.trim()),
      );
    }
    const statusResult = yield* Effect.result(
      processRunner.run({
        command: decoded.value.binaryPath,
        args: ["auth", "status", "--json"],
        env: claudeEnvironment,
        timeout: "8 seconds",
        maxOutputBytes: 32 * 1024,
      }),
    );
    const status =
      Result.isSuccess(statusResult) && statusResult.success.code === 0
        ? Option.getOrNull(decodeClaudeAuthStatus(statusResult.success.stdout))
        : null;
    let credentials: ClaudeNativeCredentials | null =
      explicitToken === undefined ? null : { accessToken: explicitToken, planLabel: null };
    if (credentials === null) {
      const credentialsPath = decoded.value.homePath.trim()
        ? NodePath.join(expandHomePath(decoded.value.homePath.trim()), ".credentials.json")
        : NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json");
      credentials = readClaudeNativeCredentialsFile(credentialsPath);
    }
    if (credentials === null && hostPlatform === "darwin") {
      const keychain = yield* Effect.result(
        processRunner.run({
          command: "/usr/bin/security",
          args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          timeout: "8 seconds",
          maxOutputBytes: 128 * 1024,
        }),
      );
      if (Result.isSuccess(keychain) && keychain.success.code === 0) {
        credentials = parseClaudeNativeCredentialsText(keychain.success.stdout);
      }
    }
    if (credentials === null) {
      return {
        providerInstanceId: instanceId,
        provider: instance.driver,
        displayName: displayName(instance, "Claude"),
        accountLabel: status?.email?.trim() || null,
        planLabel: status?.subscriptionType?.trim() || null,
        source: null,
        status: status?.loggedIn === true ? "unavailable" : "setupRequired",
        windows: [],
        observedAt,
        message:
          status?.loggedIn === true
            ? "Claude is signed in, but its OAuth credential could not be read from the native store."
            : "Sign in with Claude Code to show plan limits.",
      } satisfies ProviderQuotaAccount;
    }
    const result = yield* Effect.result(readClaudeDocument(credentials.accessToken));
    if (Result.isFailure(result)) {
      const cached = lastGood.get(instanceId);
      return {
        ...(cached ?? {
          providerInstanceId: instanceId,
          provider: instance.driver,
          displayName: displayName(instance, "Claude"),
          accountLabel: null,
          planLabel: null,
          source: "oauth" as const,
          windows: [],
          observedAt,
        }),
        status: "failed" as const,
        message: errorMessage(result.failure, "Claude limits could not be read."),
      } satisfies ProviderQuotaAccount;
    }
    const windows = parseClaudeUsage(result.success);
    const account = {
      providerInstanceId: instanceId,
      provider: instance.driver,
      displayName: displayName(instance, "Claude"),
      accountLabel: status?.email?.trim() || null,
      planLabel: (credentials.planLabel ?? status?.subscriptionType?.trim()) || null,
      source: "oauth",
      status: windows.length > 0 ? "ok" : "unavailable",
      windows,
      observedAt,
      message:
        windows.length > 0 ? null : "Claude did not report subscription limits for this account.",
    } satisfies ProviderQuotaAccount;
    if (account.status === "ok") lastGood.set(instanceId, account);
    return account;
  });

  const readOpenCode = Effect.fn("ProviderQuotaService.readOpenCode")(function* (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    observedAt: string,
    nowMs: number,
  ) {
    const decoded = yield* decodeOpenCodeSettings(instance.config).pipe(Effect.option);
    const environment = environmentFor(instance);
    const cookie = configuredValue("OPENCODE_GO_AUTH_COOKIE", environment);
    const workspaceId = configuredValue("OPENCODE_GO_WORKSPACE_ID", environment);
    if (decoded._tag === "None") {
      return {
        providerInstanceId: instanceId,
        provider: instance.driver,
        displayName: displayName(instance, "OpenCode Go"),
        accountLabel: null,
        planLabel: "Go",
        source: null,
        status: "unavailable",
        windows: [],
        observedAt,
        message: "This OpenCode instance has invalid settings.",
      } satisfies ProviderQuotaAccount;
    }
    if (
      cookie !== undefined &&
      workspaceId !== undefined &&
      !/^wrk_[A-Za-z0-9]+$/.test(workspaceId)
    ) {
      return {
        providerInstanceId: instanceId,
        provider: instance.driver,
        displayName: displayName(instance, "OpenCode Go"),
        accountLabel: workspaceId,
        planLabel: "Go",
        source: null,
        status: "setupRequired",
        windows: [],
        observedAt,
        message: "The configured OpenCode Go workspace id is invalid.",
      } satisfies ProviderQuotaAccount;
    }
    if (cookie === undefined || workspaceId === undefined) {
      const dataRoot =
        configuredValue("XDG_DATA_HOME", environment) ??
        NodePath.join(NodeOS.homedir(), ".local", "share");
      const openCodeDir = NodePath.join(dataRoot, "opencode");
      const authPath = NodePath.join(openCodeDir, "auth.json");
      const apiKey = readOpenCodeGoApiKey(authPath);
      if (apiKey !== null) {
        const apiResult = yield* Effect.result(readOpenCodeApiUsage(apiKey));
        if (Result.isSuccess(apiResult)) {
          const windows = parseOpenCodeGoUsage(apiResult.success, nowMs);
          const account = {
            providerInstanceId: instanceId,
            provider: instance.driver,
            displayName: displayName(instance, "OpenCode Go"),
            accountLabel: null,
            planLabel: "Go",
            source: "api",
            status: windows.length > 0 ? ("ok" as const) : ("unavailable" as const),
            windows,
            observedAt,
            message:
              windows.length > 0
                ? null
                : "OpenCode Go's API did not report recognizable quota windows.",
          } satisfies ProviderQuotaAccount;
          if (account.status === "ok") lastGood.set(instanceId, account);
          return account;
        }
        const cached = lastGood.get(instanceId);
        if (cached !== undefined) {
          return {
            ...cached,
            status: "failed",
            message: errorMessage(apiResult.failure, "OpenCode Go API usage could not be read."),
          } satisfies ProviderQuotaAccount;
        }
      }
      const configuredDatabase = configuredValue("OPENCODE_DB", environment);
      const databasePath = configuredDatabase
        ? NodePath.isAbsolute(configuredDatabase)
          ? configuredDatabase
          : NodePath.join(openCodeDir, configuredDatabase)
        : NodePath.join(openCodeDir, "opencode.db");
      const local = readOpenCodeGoLocalQuota({
        authPath,
        databasePath,
        nowMs,
      });
      const account = {
        providerInstanceId: instanceId,
        provider: instance.driver,
        displayName: displayName(instance, "OpenCode Go"),
        accountLabel: null,
        planLabel: "Go",
        source:
          local.windows.length > 0 ? ("local" as const) : apiKey === null ? null : ("api" as const),
        status:
          local.windows.length > 0
            ? ("ok" as const)
            : local.authenticated
              ? ("unavailable" as const)
              : ("setupRequired" as const),
        windows: local.windows,
        observedAt,
        message:
          local.windows.length > 0
            ? "Estimated from finalized OpenCode Go costs stored on this environment."
            : apiKey !== null
              ? "OpenCode Go is signed in, but its usage API was temporarily unavailable and no local history was found."
              : "Sign in with OpenCode Go to show plan limits.",
      } satisfies ProviderQuotaAccount;
      if (account.status === "ok") lastGood.set(instanceId, account);
      return account;
    }
    const result = yield* Effect.result(readOpenCodeDocument(workspaceId, cookie, nowMs));
    if (Result.isFailure(result)) {
      const cached = lastGood.get(instanceId);
      return {
        ...(cached ?? {
          providerInstanceId: instanceId,
          provider: instance.driver,
          displayName: displayName(instance, "OpenCode Go"),
          accountLabel: workspaceId,
          planLabel: "Go",
          source: "web" as const,
          windows: [],
          observedAt,
        }),
        status: "failed" as const,
        message: errorMessage(result.failure, "OpenCode Go limits could not be read."),
      } satisfies ProviderQuotaAccount;
    }
    const windows = parseOpenCodeGoUsage(result.success, nowMs);
    const account = {
      providerInstanceId: instanceId,
      provider: instance.driver,
      displayName: displayName(instance, "OpenCode Go"),
      accountLabel: workspaceId,
      planLabel: "Go",
      source: "web",
      status: windows.length > 0 ? "ok" : "unavailable",
      windows,
      observedAt,
      message: windows.length > 0 ? null : "OpenCode Go did not report recognizable quota windows.",
    } satisfies ProviderQuotaAccount;
    if (account.status === "ok") lastGood.set(instanceId, account);
    return account;
  });

  const read = Effect.fn("ProviderQuotaService.read")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const readAt = DateTime.formatIso(now);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderQuotaReadError({ detail: "Server settings could not be read.", cause }),
      ),
    );
    const instances = deriveProviderInstanceConfigMap(settings);
    const supported = Object.entries(instances).filter(
      ([, instance]) =>
        instance.enabled !== false &&
        (instance.driver === "codex" ||
          instance.driver === "claudeAgent" ||
          instance.driver === "opencode"),
    );
    const accounts = yield* Effect.all(
      supported.map(([rawInstanceId, instance]) => {
        const instanceId = rawInstanceId as ProviderInstanceId;
        switch (instance.driver) {
          case "codex":
            return readCodex(instanceId, instance, readAt);
          case "claudeAgent":
            return readClaude(instanceId, instance, readAt);
          default:
            return readOpenCode(instanceId, instance, readAt, nowMs);
        }
      }),
      { concurrency: 3 },
    );
    return {
      contractVersion: PROVIDER_QUOTA_CONTRACT_VERSION,
      readAt,
      accounts,
    } satisfies ProviderQuotaSummary;
  });

  return ProviderQuotaService.of({ read: read() });
});

export const layer = Layer.effect(ProviderQuotaService, make);

export const layerTest = (accounts: readonly ProviderQuotaAccount[] = []) =>
  Layer.succeed(
    ProviderQuotaService,
    ProviderQuotaService.of({
      read: Effect.succeed({
        contractVersion: PROVIDER_QUOTA_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        accounts,
      }),
    }),
  );
