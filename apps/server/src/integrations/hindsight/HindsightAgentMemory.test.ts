// @effect-diagnostics nodeBuiltinImport:off - the fake installer writes agent config synchronously.
/**
 * Agent memory runs Hindsight's installer against real files in a temp home,
 * with the installer itself faked: it writes the same `coding-agents` hook
 * markers the real one does, so detection is exercised for real. The cases
 * pin the promises the toggle makes — it wires what is present, only acts on
 * drift, and switching it off undoes only what T3 Code did.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parse as parseYaml } from "yaml";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as HindsightAgentMemory from "./HindsightAgentMemory.ts";
import * as HindsightService from "./HindsightService.ts";

const BASE_URL = "http://100.64.0.1:8888";

interface Options {
  readonly agentMemory: boolean;
  readonly connection?: { readonly baseUrl: string; readonly apiKey: string | null } | null;
  readonly missing?: ReadonlyArray<string>;
  readonly hermesYaml?: string;
  readonly hermesHasHindsight?: boolean;
  readonly preinstalled?: boolean;
  /** T3 Code's own environment, which provider instances inherit. */
  readonly hostEnv?: Record<string, string>;
  /** Puts a non-empty directory where the ledger goes, so saving it fails. */
  readonly unsavableLedger?: boolean;
}

const writeJson = (file: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, JSON.stringify(value));
};

const readJson = (file: string): unknown => JSON.parse(NodeFS.readFileSync(file, "utf8"));

const hooksFor = (home: string) => ({
  Stop: [{ hooks: [{ command: `node "${home}/.hindsight/coding-agents/dist/stop-hook.js"` }] }],
});

/** What the real installer leaves behind for the targets it was given. */
function fakeInstaller(home: string, args: ReadonlyArray<string>) {
  const claudeSettings = NodePath.join(home, ".claude", "settings.json");
  const codexHooks = NodePath.join(home, ".codex", "hooks.json");
  if (args.includes("install")) {
    if (args.includes("claude-code")) writeJson(claudeSettings, { hooks: hooksFor(home) });
    if (args.includes("codex")) writeJson(codexHooks, { hooks: hooksFor(home) });
    // Like the real one: merged into what is there, and a token only set when given.
    const configFile = NodePath.join(home, ".hindsight", "coding-agent.json");
    const existing = NodeFS.existsSync(configFile) ? (readJson(configFile) as object) : {};
    const token = args.includes("--api-token") ? args[args.indexOf("--api-token") + 1] : undefined;
    writeJson(configFile, {
      ...existing,
      serverMode: "self-hosted",
      apiUrl: args[args.indexOf("--api-url") + 1],
      ...(token === undefined ? {} : { apiToken: token }),
    });
  } else {
    if (args.includes("claude-code")) writeJson(claudeSettings, { hooks: {} });
    if (args.includes("codex")) writeJson(codexHooks, { hooks: {} });
  }
}

function setup(options: Options) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-memory-"));
  const hermesHome = NodePath.join(home, ".hermes");
  NodeFS.mkdirSync(hermesHome, { recursive: true });
  if (options.hermesYaml !== undefined) {
    NodeFS.writeFileSync(NodePath.join(hermesHome, "config.yaml"), options.hermesYaml);
  }
  const stateBase = NodePath.join(home, "t3");
  if (options.unsavableLedger) {
    const blocked = NodePath.join(stateBase, "userdata", "hindsight-agent-memory.json");
    NodeFS.mkdirSync(blocked, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(blocked, "keep"), "");
  }
  if (options.preinstalled)
    fakeInstaller(home, ["install", "claude-code", "codex", "--api-url", BASE_URL]);
  const calls: Array<ReadonlyArray<string>> = [];
  let connection =
    options.connection === undefined ? { baseUrl: BASE_URL, apiKey: null } : options.connection;
  const missing = new Set(options.missing ?? []);

  const runner = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          fakeInstaller(home, input.args);
          return {
            stdout: "",
            stderr: "",
            code: 0 as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
  );

  // Hermes resolves a Hindsight connection once it has a config file of its own.
  const hindsight = Layer.effect(
    HindsightService.HindsightService,
    Effect.gen(function* () {
      const base = yield* HindsightService.HindsightService;
      return HindsightService.HindsightService.of({
        ...base,
        resolveConnection: Effect.sync(() => {
          const hermesConfigured =
            options.hermesHasHindsight === true ||
            NodeFS.existsSync(NodePath.join(hermesHome, "hindsight", "config.json"));
          return {
            enabled: true,
            connection:
              connection === null
                ? null
                : { source: "settings" as const, defaultBank: null, ...connection },
            hermes: hermesConfigured
              ? { configPath: null, baseUrl: BASE_URL, bank: "hermes", apiKey: null }
              : null,
          };
        }),
      });
    }),
  ).pipe(Layer.provide(HindsightService.layerTest));

  const settings = ServerSettings.layerTest({
    integrations: { hindsight: { agentMemory: options.agentMemory } },
    providers: { hermes: { enabled: true } },
  });

  const layer = Layer.effect(
    HindsightAgentMemory.HindsightAgentMemory,
    HindsightAgentMemory.make({ homeDir: home }),
  ).pipe(
    Layer.provideMerge(settings),
    Layer.provide(hindsight),
    Layer.provide(runner),
    Layer.provide(ServerConfig.layerTest(home, stateBase)),
    Layer.provide(
      Layer.succeed(CommandAvailability, (command) => Effect.succeed(!missing.has(command))),
    ),
    Layer.provide(Layer.succeed(HostProcessEnvironment, options.hostEnv ?? {})),
    Layer.provideMerge(NodeServices.layer),
  );

  const setAgentMemory = (agentMemory: boolean) =>
    Effect.flatMap(ServerSettings.ServerSettingsService, (service) =>
      service.updateSettings({ integrations: { hindsight: { agentMemory } } }),
    );

  const apply = Effect.flatMap(
    HindsightAgentMemory.HindsightAgentMemory,
    (service) => service.apply,
  );

  const setConnection = (
    next: { readonly baseUrl: string; readonly apiKey: string | null } | null,
  ) => {
    connection = next;
  };

  /** Points the Hermes instance at another `HERMES_HOME`. */
  const setHermesHome = (hermesHomePath: string) =>
    Effect.flatMap(ServerSettings.ServerSettingsService, (service) =>
      service.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("hermes")]: {
            driver: ProviderDriverKind.make("hermes"),
            enabled: true,
            environment: [{ name: "HERMES_HOME", value: hermesHomePath, sensitive: false }],
          },
        },
      }),
    );

  return {
    home,
    hermesHome,
    /** CLIs not on the host; add one to take that agent away. */
    missing,
    calls,
    layer,
    setAgentMemory,
    setConnection,
    setHermesHome,
    apply,
  };
}

const hermesProvider = (hermesHome: string) =>
  (
    parseYaml(NodeFS.readFileSync(NodePath.join(hermesHome, "config.yaml"), "utf8")) as {
      memory?: { provider?: string };
    } | null
  )?.memory?.provider;

describe("installerArgs", () => {
  it("points a self-hosted server at its URL and passes a key only when there is one", () => {
    expect(
      HindsightAgentMemory.installerArgs("install", ["claudeCode", "codex"], {
        baseUrl: BASE_URL,
        apiKey: null,
      }),
    ).toEqual([
      "--yes",
      HindsightAgentMemory.HINDSIGHT_INSTALLER_PACKAGE,
      "install",
      "claude-code",
      "codex",
      "--server",
      "self-hosted",
      "--api-url",
      BASE_URL,
    ]);
    expect(
      HindsightAgentMemory.installerArgs("install", ["codex"], {
        baseUrl: "https://api.hindsight.vectorize.io",
        apiKey: "hsk_123",
      }).slice(3),
    ).toEqual(["codex", "--server", "cloud", "--api-token", "hsk_123"]);
  });

  it("treats an installer config for another server as stale", () => {
    const connection = { baseUrl: BASE_URL, apiKey: null };
    expect(
      HindsightAgentMemory.installerConfigMatches(
        { serverMode: "self-hosted", apiUrl: BASE_URL },
        connection,
      ),
    ).toBe(true);
    expect(
      HindsightAgentMemory.installerConfigMatches(
        { serverMode: "self-hosted", apiUrl: "http://localhost:8888" },
        connection,
      ),
    ).toBe(false);
    expect(HindsightAgentMemory.installerConfigMatches({ serverMode: "cloud" }, connection)).toBe(
      false,
    );
    // A key the connection no longer has must not keep riding along.
    expect(
      HindsightAgentMemory.installerConfigMatches(
        { serverMode: "self-hosted", apiUrl: BASE_URL, apiToken: "hsk_old" },
        connection,
      ),
    ).toBe(false);
  });
});

describe("HindsightAgentMemory", () => {
  it.effect("installs once for every present agent, then leaves a wired host alone", () => {
    const harness = setup({
      agentMemory: true,
      hermesHasHindsight: true,
      hermesYaml: "memory:\n  provider: hindsight\n",
    });
    return Effect.gen(function* () {
      const state = yield* harness.apply;
      yield* harness.apply;

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toContain("claude-code");
      expect(harness.calls[0]).toContain("codex");
      expect(state.blocker).toBeNull();
      expect(state.agents.map((agent) => [agent.target, agent.state])).toEqual([
        ["claudeCode", "installed"],
        ["codex", "installed"],
        ["hermes", "installed"],
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("switching off uninstalls what it installed and nothing else", () => {
    const harness = setup({
      agentMemory: true,
      hermesHasHindsight: true,
      hermesYaml: "memory:\n  provider: hindsight\n",
    });
    return Effect.gen(function* () {
      yield* harness.apply;
      yield* harness.setAgentMemory(false);
      const state = yield* harness.apply;

      expect(harness.calls.at(-1)?.slice(2)).toEqual(["uninstall", "claude-code", "codex"]);
      expect(state.agents.find((agent) => agent.target === "claudeCode")?.state).toBe(
        "notInstalled",
      );
      // Hermes already used Hindsight before T3 Code touched it.
      expect(hermesProvider(harness.hermesHome)).toBe("hindsight");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never tears down an install it did not make", () => {
    const harness = setup({ agentMemory: false, preinstalled: true });
    return Effect.gen(function* () {
      const state = yield* harness.apply;

      expect(harness.calls).toEqual([]);
      expect(state.agents.find((agent) => agent.target === "codex")?.state).toBe("installed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("only adopts a hand-made install's server, and keeps it on the way out", () => {
    const harness = setup({ agentMemory: true, preinstalled: true, missing: ["hermes"] });
    return Effect.gen(function* () {
      yield* harness.apply;
      yield* harness.setAgentMemory(false);
      yield* harness.apply;

      expect(harness.calls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reinstalls when the connection moves to another server", () => {
    const harness = setup({ agentMemory: true, missing: ["hermes"] });
    return Effect.gen(function* () {
      yield* harness.apply;
      writeJson(NodePath.join(harness.home, ".hindsight", "coding-agent.json"), {
        serverMode: "self-hosted",
        apiUrl: "http://old-host:8888",
      });
      yield* harness.apply;

      expect(harness.calls).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("spawns nothing without a connection or without Node", () => {
    const unconfigured = setup({ agentMemory: true, connection: null });
    const noNode = setup({ agentMemory: true, missing: ["npx", "hermes"] });
    return Effect.gen(function* () {
      const unconfiguredState = yield* unconfigured.apply.pipe(Effect.provide(unconfigured.layer));
      const noNodeState = yield* noNode.apply.pipe(Effect.provide(noNode.layer));

      expect(unconfiguredState.blocker).toBe("notConfigured");
      expect(noNodeState.blocker).toBe("nodeMissing");
      expect([...unconfigured.calls, ...noNode.calls]).toEqual([]);
    });
  });

  it.effect("only wires agents whose CLI is on the host", () => {
    const harness = setup({ agentMemory: true, missing: ["codex", "hermes"] });
    return Effect.gen(function* () {
      const state = yield* harness.apply;

      expect(harness.calls[0]).toContain("claude-code");
      expect(harness.calls[0]).not.toContain("codex");
      expect(state.agents.map((agent) => agent.target)).toEqual(["claudeCode"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("switches Hermes to Hindsight and puts its own provider back", () => {
    const harness = setup({
      agentMemory: true,
      missing: ["claude", "codex"],
      hermesYaml: "# keep me\nmemory:\n  provider: holographic\n  memory_enabled: true\n",
    });
    const pluginConfig = NodePath.join(harness.hermesHome, "hindsight", "config.json");
    return Effect.gen(function* () {
      const state = yield* harness.apply;

      expect(state.agents).toEqual([{ target: "hermes", state: "installed", detail: null }]);
      expect(hermesProvider(harness.hermesHome)).toBe("hindsight");
      expect(readJson(pluginConfig)).toMatchObject({ mode: "local_external", api_url: BASE_URL });

      yield* harness.setAgentMemory(false);
      yield* harness.apply;

      expect(hermesProvider(harness.hermesHome)).toBe("holographic");
      expect(
        NodeFS.readFileSync(NodePath.join(harness.hermesHome, "config.yaml"), "utf8"),
      ).toContain("# keep me");
      expect(NodeFS.existsSync(pluginConfig)).toBe(false);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves a config.yaml it created empty once Hermes is switched back", () => {
    const harness = setup({ agentMemory: true, missing: ["claude", "codex"] });
    const configFile = NodePath.join(harness.hermesHome, "config.yaml");
    return Effect.gen(function* () {
      yield* harness.apply;
      expect(hermesProvider(harness.hermesHome)).toBe("hindsight");

      yield* harness.setAgentMemory(false);
      yield* harness.apply;

      expect(NodeFS.readFileSync(configFile, "utf8")).toBe("");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves a Hermes config.yaml it cannot parse untouched", () => {
    const broken = "memory: [unclosed\n";
    const harness = setup({ agentMemory: true, missing: ["claude", "codex"], hermesYaml: broken });
    return Effect.gen(function* () {
      const state = yield* harness.apply;

      expect(state.agents[0]?.state).toBe("failed");
      expect(NodeFS.readFileSync(NodePath.join(harness.hermesHome, "config.yaml"), "utf8")).toBe(
        broken,
      );
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("points a hand-made install back at its own server when switched off", () => {
    const harness = setup({ agentMemory: true, preinstalled: true, missing: ["hermes"] });
    const installerConfig = NodePath.join(harness.home, ".hindsight", "coding-agent.json");
    const handMade = { serverMode: "self-hosted", apiUrl: "http://own-server:8888" };
    writeJson(installerConfig, handMade);
    return Effect.gen(function* () {
      yield* harness.apply;
      expect(readJson(installerConfig)).toMatchObject({ apiUrl: BASE_URL });

      yield* harness.setAgentMemory(false);
      yield* harness.apply;

      // Its hooks were never T3 Code's, so only the config moves back.
      expect(harness.calls.map((args) => args[2])).toEqual(["install"]);
      expect(readJson(installerConfig)).toEqual(handMade);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears an API key that was removed from the connection", () => {
    const harness = setup({ agentMemory: true, missing: ["hermes"] });
    const installerConfig = NodePath.join(harness.home, ".hindsight", "coding-agent.json");
    return Effect.gen(function* () {
      harness.setConnection({ baseUrl: BASE_URL, apiKey: "hsk_old" });
      yield* harness.apply;
      expect(readJson(installerConfig)).toMatchObject({ apiToken: "hsk_old" });

      harness.setConnection({ baseUrl: BASE_URL, apiKey: null });
      const state = yield* harness.apply;

      expect(harness.calls).toHaveLength(2);
      expect(readJson(installerConfig)).not.toHaveProperty("apiToken");
      expect(state.agents.every((agent) => agent.state === "installed")).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rewrites the Hermes config it wrote when the connection moves", () => {
    const harness = setup({ agentMemory: true, missing: ["claude", "codex"] });
    const pluginConfig = NodePath.join(harness.hermesHome, "hindsight", "config.json");
    return Effect.gen(function* () {
      yield* harness.apply;
      harness.setConnection({ baseUrl: "http://new-host:8888", apiKey: "hsk_new" });
      yield* harness.apply;

      expect(readJson(pluginConfig)).toMatchObject({
        api_url: "http://new-host:8888",
        api_key: "hsk_new",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps its Hermes ledger until the undo actually lands", () => {
    const harness = setup({
      agentMemory: true,
      missing: ["claude", "codex"],
      hermesYaml: "memory:\n  provider: holographic\n",
    });
    return Effect.gen(function* () {
      yield* harness.apply;
      yield* harness.setAgentMemory(false);
      NodeFS.chmodSync(harness.hermesHome, 0o500);
      const failed = yield* harness.apply;
      NodeFS.chmodSync(harness.hermesHome, 0o700);

      expect(failed.agents[0]?.state).toBe("failed");
      expect(hermesProvider(harness.hermesHome)).toBe("hindsight");

      yield* harness.apply;
      expect(hermesProvider(harness.hermesHome)).toBe("holographic");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("puts the old Hermes home back before wiring a new one", () => {
    const harness = setup({
      agentMemory: true,
      missing: ["claude", "codex"],
      hermesYaml: "memory:\n  provider: holographic\n",
    });
    const newHome = NodePath.join(harness.home, "other-hermes");
    NodeFS.mkdirSync(newHome);
    return Effect.gen(function* () {
      yield* harness.apply;
      expect(hermesProvider(harness.hermesHome)).toBe("hindsight");

      yield* harness.setHermesHome(newHome);
      yield* harness.apply;

      expect(hermesProvider(harness.hermesHome)).toBe("holographic");
      expect(NodeFS.existsSync(NodePath.join(harness.hermesHome, "hindsight", "config.json"))).toBe(
        false,
      );
      expect(hermesProvider(newHome)).toBe("hindsight");

      yield* harness.setAgentMemory(false);
      yield* harness.apply;
      expect(hermesProvider(newHome)).toBeUndefined();
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("takes its wiring out while there is no server, and puts it back after", () => {
    const harness = setup({ agentMemory: true, hermesYaml: "memory:\n  provider: holographic\n" });
    return Effect.gen(function* () {
      yield* harness.apply;
      harness.setConnection(null);
      const off = yield* harness.apply;

      expect(off.blocker).toBe("notConfigured");
      expect(harness.calls.at(-1)?.slice(2)).toEqual(["uninstall", "claude-code", "codex"]);
      expect(hermesProvider(harness.hermesHome)).toBe("holographic");

      harness.setConnection({ baseUrl: BASE_URL, apiKey: null });
      const on = yield* harness.apply;

      expect(harness.calls.at(-1)?.[2]).toBe("install");
      expect(on.agents.every((agent) => agent.state === "installed")).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("changes nothing it could not record first", () => {
    const harness = setup({
      agentMemory: true,
      unsavableLedger: true,
      hermesYaml: "memory:\n  provider: holographic\n",
    });
    return Effect.gen(function* () {
      const state = yield* harness.apply;

      expect(harness.calls).toEqual([]);
      expect(hermesProvider(harness.hermesHome)).toBe("holographic");
      expect(state.detail).toContain("could not save");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("unwires an agent that is no longer set up, and leaves the rest", () => {
    const harness = setup({ agentMemory: true, hermesYaml: "memory:\n  provider: holographic\n" });
    return Effect.gen(function* () {
      yield* harness.apply;
      harness.missing.add("codex");
      harness.missing.add("hermes");
      const state = yield* harness.apply;

      expect(harness.calls.at(-1)?.slice(2)).toEqual(["uninstall", "codex"]);
      expect(hermesProvider(harness.hermesHome)).toBe("holographic");
      expect(state.agents).toEqual([{ target: "claudeCode", state: "installed", detail: null }]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("names an instance whose config home comes from T3 Code's own environment", () => {
    const harness = setup({
      agentMemory: true,
      missing: ["codex", "hermes"],
      hostEnv: { CLAUDE_CONFIG_DIR: "/srv/claude-work" },
    });
    return Effect.gen(function* () {
      const state = yield* harness.apply;

      expect(state.agents[0]?.detail).toContain("Not covered");
    }).pipe(Effect.provide(harness.layer));
  });
});
