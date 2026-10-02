/**
 * HindsightAgentMemory — keeps this host's coding agents wired into Hindsight.
 *
 * `integrations.hindsight.agentMemory` is the whole interface: switched on,
 * every supported agent configured on this environment recalls from and
 * retains to the Hindsight connection the Memory tab already resolves;
 * switched off, what T3 Code added is taken back out. The work runs on the
 * environment's own host, so a remote or tunnelled environment wires its own
 * agents, never the machine the client happens to run on.
 *
 * Claude Code and Codex are wired by Hindsight's own installer
 * (`@vectorize-io/hindsight-coding-agents`), which owns their hooks, MCP entry
 * and skill. Hermes has a native Hindsight memory provider, so it only needs
 * that provider switched on and, when it has no Hindsight config of its own,
 * pointed at this connection.
 *
 * A pass is idempotent and only acts on drift: it runs at startup, whenever the
 * settings it depends on change, and on an explicit retry. Undoing is driven
 * by a ledger of what T3 Code itself changed, so an agent someone wired by
 * hand — or a Hermes install that already used Hindsight — is never torn down
 * by switching this off.
 *
 * @module HindsightAgentMemory
 */
import * as NodeOS from "node:os";

import {
  type HindsightAgentMemoryBlocker,
  type HindsightAgentMemoryState,
  type HindsightAgentStatus,
  type HindsightAgentTarget,
  type ServerSettings,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { isMap, parseDocument } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "../../hermes/hermesCronState.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { HindsightService, type HindsightConnection } from "./HindsightService.ts";

/**
 * Pinned so the flags below keep meaning what they mean. The runtime the
 * installer copies into `~/.hindsight/coding-agents` updates itself.
 */
export const HINDSIGHT_INSTALLER_PACKAGE = "@vectorize-io/hindsight-coding-agents@0.8.0";

/** A cold `npx` fetch plus the installer's own `claude mcp add` can take a while. */
const INSTALLER_TIMEOUT = Duration.minutes(5);
const INSTALLER_OUTPUT_MAX_BYTES = 16 * 1024;

/** Every hook the installer writes runs from `~/.hindsight/coding-agents/…`. */
const INSTALLER_MARKER = "coding-agents";

const HINDSIGHT_CLOUD_HOST = "api.hindsight.vectorize.io";

const LEDGER_FILE = "hindsight-agent-memory.json";

type CodingAgentTarget = "claudeCode" | "codex";

const CODING_AGENTS: ReadonlyArray<{
  readonly target: CodingAgentTarget;
  readonly driver: string;
  /** Used when an instance does not set its own `binaryPath`. */
  readonly binary: string;
  readonly installerId: string;
  /** The variable a provider instance uses for its own config home. */
  readonly homeVariable: string;
}> = [
  {
    target: "claudeCode",
    driver: "claudeAgent",
    binary: "claude",
    installerId: "claude-code",
    homeVariable: "CLAUDE_CONFIG_DIR",
  },
  {
    target: "codex",
    driver: "codex",
    binary: "codex",
    installerId: "codex",
    homeVariable: "CODEX_HOME",
  },
];

const INITIAL_STATE: HindsightAgentMemoryState = {
  applying: false,
  blocker: null,
  agents: [],
  detail: null,
};

/** What T3 Code changed, so switching off undoes exactly that and nothing else. */
const AgentMemoryLedger = Schema.Struct({
  codingAgents: Schema.Array(Schema.Literals(["claudeCode", "codex"])),
  hermes: Schema.NullOr(
    Schema.Struct({
      home: Schema.String,
      /** `memory.provider` before T3 Code set it, or null when it was unset. */
      previousProvider: Schema.NullOr(Schema.String),
      changedProvider: Schema.Boolean,
      wroteConfig: Schema.Boolean,
    }),
  ),
});
type AgentMemoryLedger = typeof AgentMemoryLedger.Type;

const EMPTY_LEDGER: AgentMemoryLedger = { codingAgents: [], hermes: null };

const decodeLedger = Schema.decodeEffect(Schema.fromJsonString(AgentMemoryLedger));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isHindsightCloud(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === HINDSIGHT_CLOUD_HOST;
  } catch {
    return false;
  }
}

/** Arguments for `npx`, so the installer runs without a prompt or a TTY. */
export function installerArgs(
  action: "install" | "uninstall",
  targets: ReadonlyArray<CodingAgentTarget>,
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey"> | null,
): ReadonlyArray<string> {
  const ids = CODING_AGENTS.filter((agent) => targets.includes(agent.target)).map(
    (agent) => agent.installerId,
  );
  const args = ["--yes", HINDSIGHT_INSTALLER_PACKAGE, action, ...ids];
  if (action === "uninstall" || connection === null) return args;
  if (isHindsightCloud(connection.baseUrl)) {
    args.push("--server", "cloud");
  } else {
    args.push("--server", "self-hosted", "--api-url", connection.baseUrl);
  }
  if (connection.apiKey !== null) args.push("--api-token", connection.apiKey);
  return args;
}

/**
 * Whether the installer's own config still points where this connection does.
 * A stale one means the agents would write to the old server, so the pass
 * re-runs the installer. The token only counts when there is one to send:
 * the installer never clears a token it is not given.
 */
export function installerConfigMatches(
  config: unknown,
  connection: Pick<HindsightConnection, "baseUrl" | "apiKey">,
): boolean {
  const record = asRecord(config);
  if (record === null) return false;
  const cloud = isHindsightCloud(connection.baseUrl);
  if (record["serverMode"] !== (cloud ? "cloud" : "self-hosted")) return false;
  if (!cloud && nonEmptyString(record["apiUrl"]) !== connection.baseUrl) return false;
  if (connection.apiKey !== null && nonEmptyString(record["apiToken"]) !== connection.apiKey) {
    return false;
  }
  return true;
}

/** Whether an agent's hook config carries an entry the installer wrote. */
function hasInstallerHook(hooks: unknown): boolean {
  return hooks !== null && hooks !== undefined && JSON.stringify(hooks).includes(INSTALLER_MARKER);
}

/** The installer's failure as one short line, with the key never echoed back. */
function summarizeFailure(output: ProcessRunner.ProcessRunOutput, apiKey: string | null): string {
  if (output.timedOut) return "Hindsight's installer timed out.";
  const lines = `${output.stderr}\n${output.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    // npm's own update notices come last and say nothing about the failure.
    .filter((line) => line.length > 0 && !line.startsWith("npm notice"));
  const last = lines.at(-1) ?? `exited with code ${String(output.code)}`;
  const safe = apiKey === null ? last : last.split(apiKey).join("•••");
  return `Hindsight's installer failed: ${safe.slice(0, 240)}`;
}

interface PresentAgent {
  readonly target: HindsightAgentTarget;
  /** Instance ids that use their own config home, which the installer cannot reach. */
  readonly customHomeInstances: ReadonlyArray<string>;
  /** Hermes only: its home, after the instance's `HERMES_HOME`. */
  readonly hermesHome: string | null;
}

/** Inputs a pass depends on; a settings change that leaves this alone is skipped. */
function reconcileKey(settings: ServerSettings): string {
  const instances = Object.entries(deriveProviderInstanceConfigMap(settings)).filter(
    ([, instance]) =>
      instance.driver === "hermes" ||
      CODING_AGENTS.some((agent) => agent.driver === instance.driver),
  );
  return JSON.stringify({ hindsight: settings.integrations.hindsight, instances });
}

export class HindsightAgentMemory extends Context.Service<
  HindsightAgentMemory,
  {
    /** The current state, then every change. */
    readonly changes: Stream.Stream<HindsightAgentMemoryState>;
    /** Runs a pass now and answers with where it left things. */
    readonly apply: Effect.Effect<HindsightAgentMemoryState>;
  }
>()("t3-hermes/integrations/hindsight/HindsightAgentMemory") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("HindsightAgentMemory.make")(function* (
  options: { readonly homeDir?: string } = {},
) {
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const hindsight = yield* HindsightService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const hostEnvironment = yield* HostProcessEnvironment;
  const commandAvailable = yield* CommandAvailability;
  const homeDir = options.homeDir ?? NodeOS.homedir();
  const ledgerPath = path.join(config.stateDir, LEDGER_FILE);
  const installerConfigPath =
    nonEmptyString(hostEnvironment["HINDSIGHT_CONFIG"]) ??
    path.join(homeDir, ".hindsight", "coding-agent.json");

  const isAvailable = (command: string, env: NodeJS.ProcessEnv) =>
    commandAvailable(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  const readJson = (file: string) =>
    readText(file).pipe(
      Effect.flatMap((text) =>
        text === null
          ? Effect.succeed(null)
          : decodeJson(text).pipe(Effect.orElseSucceed(() => null)),
      ),
    );

  const readLedger = readText(ledgerPath).pipe(
    Effect.flatMap((text) =>
      text === null
        ? Effect.succeed(EMPTY_LEDGER)
        : decodeLedger(text).pipe(Effect.orElseSucceed(() => EMPTY_LEDGER)),
    ),
  );

  const writeLedger = (ledger: AgentMemoryLedger) =>
    writeFileStringAtomically({
      filePath: ledgerPath,
      contents: `${JSON.stringify(ledger, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not save the agent memory ledger", { cause }),
      ),
    );

  /** Agents with an enabled instance whose CLI is actually on this host. */
  const presentAgents = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const instances = Object.entries(deriveProviderInstanceConfigMap(settings));
      const present: Array<PresentAgent> = [];
      for (const agent of CODING_AGENTS) {
        let found = false;
        const customHomeInstances: Array<string> = [];
        for (const [instanceId, instance] of instances) {
          if (instance.driver !== agent.driver || !resolveProviderInstanceEnabled(instance))
            continue;
          const instanceConfig = asRecord(instance.config) ?? {};
          const env = mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
          const binary = nonEmptyString(instanceConfig["binaryPath"]) ?? agent.binary;
          if (!(yield* isAvailable(binary, env))) continue;
          found = true;
          const ownHome =
            nonEmptyString(instanceConfig["homePath"]) ??
            nonEmptyString(
              instance.environment?.find((entry) => entry.name === agent.homeVariable)?.value,
            );
          if (ownHome !== null) customHomeInstances.push(instanceId);
        }
        if (found) present.push({ target: agent.target, customHomeInstances, hermesHome: null });
      }
      const hermes = resolveEnabledHermesInstance(settings);
      if (hermes !== null) {
        const env = mergeProviderInstanceEnvironment(hermes.environment, hostEnvironment);
        const binary = nonEmptyString(hermes.settings.binaryPath) ?? "hermes";
        if (yield* isAvailable(binary, env)) {
          present.push({
            target: "hermes",
            customHomeInstances: [],
            hermesHome: resolveHermesHome(env, homeDir),
          });
        }
      }
      return present;
    });

  const codingAgentInstalled = (target: CodingAgentTarget) =>
    target === "claudeCode"
      ? readJson(path.join(homeDir, ".claude", "settings.json")).pipe(
          Effect.map((settings) => hasInstallerHook(asRecord(settings)?.["hooks"])),
        )
      : readJson(path.join(homeDir, ".codex", "hooks.json")).pipe(Effect.map(hasInstallerHook));

  const runInstaller = (
    action: "install" | "uninstall",
    targets: ReadonlyArray<CodingAgentTarget>,
    connection: HindsightConnection | null,
  ) =>
    runner
      .run({
        command: "npx",
        args: installerArgs(action, targets, connection),
        cwd: homeDir,
        timeout: INSTALLER_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
        maxOutputBytes: INSTALLER_OUTPUT_MAX_BYTES,
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 && !output.timedOut
            ? null
            : summarizeFailure(output, connection?.apiKey ?? null),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Hindsight's installer could not be started", { error }).pipe(
            Effect.as("Hindsight's installer could not be started."),
          ),
        ),
      );

  const hermesConfigFile = (home: string) => path.join(home, "config.yaml");
  const hermesHindsightFile = (home: string) => path.join(home, "hindsight", "config.json");

  /** `memory.provider`, or `undefined` when `config.yaml` exists but does not parse. */
  const readHermesProvider = (home: string) =>
    readText(hermesConfigFile(home)).pipe(
      Effect.map((text) => {
        const document = parseDocument(text ?? "");
        if (document.errors.length > 0) return undefined;
        return nonEmptyString(document.getIn(["memory", "provider"]));
      }),
    );

  /**
   * Sets or clears `memory.provider`. Never rewrites a `config.yaml` that does
   * not parse: a typo elsewhere in a file Hermes owns must survive this.
   */
  const writeHermesProvider = (home: string, provider: string | null) =>
    Effect.gen(function* () {
      const document = parseDocument((yield* readText(hermesConfigFile(home))) ?? "");
      if (document.errors.length > 0) return false;
      if (provider === null) {
        document.deleteIn(["memory", "provider"]);
        const memory = document.getIn(["memory"]);
        if (isMap(memory) && memory.items.length === 0) document.deleteIn(["memory"]);
      } else {
        document.setIn(["memory", "provider"], provider);
      }
      // A file left with nothing in it reads better empty than as `{}`.
      const emptied = isMap(document.contents) && document.contents.items.length === 0;
      return yield* writeFileStringAtomically({
        filePath: hermesConfigFile(home),
        contents: emptied ? "" : document.toString(),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    });

  /**
   * Hermes' plugin config for this connection. Written owner-only because a
   * Hindsight Cloud key may ride in it.
   */
  const writeHermesHindsightConfig = (home: string, connection: HindsightConnection) => {
    const cloud = isHindsightCloud(connection.baseUrl);
    const contents = {
      mode: cloud ? "cloud" : "local_external",
      api_url: connection.baseUrl,
      bank_id: "hermes",
      ...(connection.apiKey === null ? {} : { api_key: connection.apiKey }),
    };
    const file = hermesHindsightFile(home);
    return writeFileStringAtomically({
      filePath: file,
      contents: `${JSON.stringify(contents, null, 2)}\n`,
    }).pipe(
      Effect.andThen(fs.chmod(file, 0o600)),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  };

  const state = yield* SubscriptionRef.make<HindsightAgentMemoryState>(INITIAL_STATE);
  const lock = yield* Semaphore.make(1);
  const markApplying = SubscriptionRef.update(state, (current) => ({ ...current, applying: true }));

  const pass = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return yield* SubscriptionRef.get(state);
    const desired = settings.integrations.hindsight.agentMemory;
    const resolved = yield* hindsight.resolveConnection;
    const connection = resolved.connection;
    const agents = yield* presentAgents(settings);
    const ledger = yield* readLedger;
    let nextLedger = ledger;
    let blocker: HindsightAgentMemoryBlocker | null = null;
    const failures = new Map<HindsightAgentTarget, string>();

    const coding = agents.flatMap((agent) =>
      agent.target === "claudeCode" || agent.target === "codex" ? [agent.target] : [],
    );

    if (desired) {
      if (connection === null) {
        blocker = "notConfigured";
      } else if (coding.length > 0) {
        const wiredBefore = new Set<CodingAgentTarget>();
        for (const target of coding) {
          if (yield* codingAgentInstalled(target)) wiredBefore.add(target);
        }
        const configMatches = installerConfigMatches(
          yield* readJson(installerConfigPath),
          connection,
        );
        if (!configMatches || wiredBefore.size < coding.length) {
          if (!(yield* isAvailable("npx", hostEnvironment))) {
            blocker = "nodeMissing";
          } else {
            yield* markApplying;
            const failure = yield* runInstaller("install", coding, connection);
            if (failure === null) {
              const ownedByT3 = new Set([
                ...ledger.codingAgents,
                ...coding.filter((target) => !wiredBefore.has(target)),
              ]);
              nextLedger = { ...nextLedger, codingAgents: [...ownedByT3] };
            } else {
              for (const target of coding) failures.set(target, failure);
            }
          }
        }
      }
    } else if (ledger.codingAgents.length > 0) {
      if (!(yield* isAvailable("npx", hostEnvironment))) {
        blocker = "nodeMissing";
      } else {
        yield* markApplying;
        const failure = yield* runInstaller("uninstall", ledger.codingAgents, null);
        if (failure === null) {
          nextLedger = { ...nextLedger, codingAgents: [] };
        } else {
          for (const target of ledger.codingAgents) failures.set(target, failure);
        }
      }
    }

    const hermes = agents.find((agent) => agent.target === "hermes");
    if (desired && connection !== null && hermes?.hermesHome) {
      const home = hermes.hermesHome;
      const provider = yield* readHermesProvider(home);
      if (provider === undefined) {
        failures.set("hermes", "Hermes' config.yaml could not be parsed, so it was left alone.");
      } else {
        const wroteConfig =
          resolved.hermes === null ? yield* writeHermesHindsightConfig(home, connection) : false;
        const changedProvider =
          provider !== "hindsight" ? yield* writeHermesProvider(home, "hindsight") : false;
        if (provider !== "hindsight" && !changedProvider) {
          failures.set("hermes", "Hermes' config.yaml could not be updated.");
        }
        if (wroteConfig || changedProvider) {
          const previous = ledger.hermes?.home === home ? ledger.hermes : null;
          nextLedger = {
            ...nextLedger,
            hermes: {
              home,
              previousProvider: previous?.changedProvider ? previous.previousProvider : provider,
              changedProvider: changedProvider || (previous?.changedProvider ?? false),
              wroteConfig: wroteConfig || (previous?.wroteConfig ?? false),
            },
          };
        }
      }
    } else if (!desired && ledger.hermes !== null) {
      const owned = ledger.hermes;
      // Only put the provider back if it is still the one T3 Code set.
      if (owned.changedProvider && (yield* readHermesProvider(owned.home)) === "hindsight") {
        yield* markApplying;
        yield* writeHermesProvider(owned.home, owned.previousProvider);
      }
      if (owned.wroteConfig) {
        yield* fs.remove(hermesHindsightFile(owned.home)).pipe(Effect.ignore);
      }
      nextLedger = { ...nextLedger, hermes: null };
    }

    if (nextLedger !== ledger) yield* writeLedger(nextLedger);

    const after =
      nextLedger.hermes !== ledger.hermes ? yield* hindsight.resolveConnection : resolved;
    const statuses: Array<HindsightAgentStatus> = [];
    for (const agent of agents) {
      const failure = failures.get(agent.target) ?? null;
      const installed =
        agent.target === "hermes"
          ? agent.hermesHome !== null &&
            after.hermes !== null &&
            (yield* readHermesProvider(agent.hermesHome)) === "hindsight"
          : yield* codingAgentInstalled(agent.target);
      const note =
        agent.customHomeInstances.length > 0
          ? `Not covered: ${agent.customHomeInstances.join(", ")} (own config home).`
          : null;
      statuses.push({
        target: agent.target,
        state: failure !== null ? "failed" : installed ? "installed" : "notInstalled",
        detail: failure ?? note,
      });
    }
    return {
      applying: false,
      blocker,
      agents: statuses,
      detail: null,
    } satisfies HindsightAgentMemoryState;
  });

  const apply = lock.withPermits(1)(
    pass.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Hindsight agent memory pass failed", cause).pipe(
          Effect.andThen(SubscriptionRef.get(state)),
          Effect.map((current): HindsightAgentMemoryState => ({
            ...current,
            applying: false,
            detail: "Applying agent memory failed. The server log has the details.",
          })),
        ),
      ),
      Effect.tap((next) => SubscriptionRef.set(state, next)),
    ),
  );

  // Subscribe before the first pass so a change made while it runs is not missed.
  const settingsChanges = yield* settingsService.subscribeChanges;
  const initialSettings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
  let lastKey = initialSettings === null ? null : reconcileKey(initialSettings);
  yield* apply.pipe(
    Effect.andThen(
      settingsChanges.pipe(
        Stream.runForEach((next) => {
          const key = reconcileKey(next);
          if (key === lastKey) return Effect.void;
          lastKey = key;
          return apply;
        }),
      ),
    ),
    Effect.forkScoped,
  );

  return HindsightAgentMemory.of({ changes: SubscriptionRef.changes(state), apply });
});

export const layer = Layer.effect(HindsightAgentMemory, make());

/** Inert service, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  HindsightAgentMemory,
  HindsightAgentMemory.of({
    changes: Stream.make(INITIAL_STATE),
    apply: Effect.succeed(INITIAL_STATE),
  }),
);
