import { describe, expect, it } from "vite-plus/test";

import {
  parseDotenv,
  resolveHermesHindsightPaths,
  resolveHermesHindsightConfig,
} from "./hermesHindsightConfig.ts";

const CONFIG_PATH = "/home/me/.hermes/hindsight/config.json";

describe("resolveHermesHindsightConfig", () => {
  it("reads a local_external config file", () => {
    expect(
      resolveHermesHindsightConfig({
        config: {
          path: CONFIG_PATH,
          value: { mode: "local_external", api_url: "http://100.64.0.7:8888", bank_id: "work" },
        },
        environment: {},
      }),
    ).toEqual({
      configPath: CONFIG_PATH,
      baseUrl: "http://100.64.0.7:8888",
      bank: "work",
      apiKey: null,
    });
  });

  it("falls back the way Hermes does inside a config file", () => {
    expect(
      resolveHermesHindsightConfig({
        config: {
          path: CONFIG_PATH,
          value: { mode: "cloud", apiKey: "", banks: { hermes: { bankId: "legacy" } } },
        },
        environment: { HINDSIGHT_API_KEY: "env-key" },
      }),
    ).toEqual({
      configPath: CONFIG_PATH,
      baseUrl: "https://api.hindsight.vectorize.io",
      bank: "legacy",
      apiKey: "env-key",
    });
  });

  it("uses HINDSIGHT_* variables when there is no config file", () => {
    expect(
      resolveHermesHindsightConfig({
        config: null,
        environment: { HINDSIGHT_MODE: "local_external" },
      }),
    ).toEqual({
      configPath: null,
      baseUrl: "http://localhost:8888",
      bank: "hermes",
      apiKey: null,
    });
  });

  it("accepts every local mode from variables alone", () => {
    expect(
      resolveHermesHindsightConfig({
        config: null,
        environment: { HINDSIGHT_MODE: "local_embedded" },
      })?.baseUrl,
    ).toBe("http://localhost:8888");
  });

  it("reports nothing when Hermes is not set up for Hindsight", () => {
    expect(resolveHermesHindsightConfig({ config: null, environment: {} })).toBeNull();
    // A cloud config with neither key nor URL fails Hermes' own availability check.
    expect(
      resolveHermesHindsightConfig({
        config: { path: CONFIG_PATH, value: { mode: "cloud", bank_id: "hermes" } },
        environment: {},
      }),
    ).toBeNull();
  });
});

describe("resolveHermesHindsightPaths", () => {
  it("expands a ~/ HERMES_HOME against the instance's own home, as agent memory does", () => {
    expect(
      resolveHermesHindsightPaths({ HERMES_HOME: "~/custom", HOME: "/home/hermes-user" })
        .configFiles[0],
    ).toBe("/home/hermes-user/custom/hindsight/config.json");
  });
});

describe("parseDotenv", () => {
  it("reads quoted, exported and commented values", () => {
    expect(
      parseDotenv(
        [
          "# Hermes secrets",
          "export HINDSIGHT_API_KEY='quoted # kept'",
          "HINDSIGHT_API_URL=http://localhost:8888 # trailing comment",
          'HINDSIGHT_BANK_ID="work" # rotated monthly',
          'HINDSIGHT_MODE="a\\"b"',
          "BROKEN LINE",
        ].join("\n"),
      ),
    ).toEqual({
      HINDSIGHT_API_KEY: "quoted # kept",
      HINDSIGHT_API_URL: "http://localhost:8888",
      HINDSIGHT_BANK_ID: "work",
      HINDSIGHT_MODE: 'a"b',
    });
  });
});
