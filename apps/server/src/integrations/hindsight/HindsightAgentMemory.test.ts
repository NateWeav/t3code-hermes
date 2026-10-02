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
    const apiUrl = args[args.indexOf("--api-url") + 1];
    writeJson(NodePath.join(home, ".hindsight", "coding-agent.json"), {
      serverMode: "self-hosted",
      apiUrl,
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
  if (options.preinstalled)
    fakeInstaller(home, ["install", "claude-code", "codex", "--api-url", BASE_URL]);
  const calls: Array<ReadonlyArray<string>> = [];
  const connection =
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
    Layer.provide(ServerConfig.layerTest(home, { prefix: "t3-agent-memory-state-" })),
    Layer.provide(
      Layer.succeed(CommandAvailability, (command) => Effect.succeed(!missing.has(command))),
    ),
    Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
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

  return { home, hermesHome, calls, layer, setAgentMemory, apply };
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
});
