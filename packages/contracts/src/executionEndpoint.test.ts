import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_EXECUTION_ENDPOINT_ID,
  ExecutionEndpointConfig,
  ExecutionEndpointId,
  ExecutionEndpointUpsertInput,
} from "./executionEndpoint.ts";

const decodeConfig = Schema.decodeUnknownSync(ExecutionEndpointConfig);
const decodeUpsert = Schema.decodeUnknownSync(ExecutionEndpointUpsertInput);

describe("execution endpoint contracts", () => {
  it("brands local as the built-in endpoint id", () => {
    expect(DEFAULT_EXECUTION_ENDPOINT_ID).toBe(ExecutionEndpointId.make("local"));
  });

  it("decodes minimal local and SSH configs with safe defaults", () => {
    expect(decodeConfig({ kind: "local", displayName: "Local", enabled: true })).toEqual({
      kind: "local",
      displayName: "Local",
      enabled: true,
    });

    expect(
      decodeConfig({
        kind: "ssh",
        displayName: "Build host",
        enabled: true,
        host: "builder.internal",
        user: "aeris",
        identityFile: "/home/aeris/.ssh/id_ed25519",
        cwd: "/srv/work",
      }),
    ).toEqual({
      kind: "ssh",
      displayName: "Build host",
      enabled: true,
      host: "builder.internal",
      user: "aeris",
      port: 22,
      identityFile: "/home/aeris/.ssh/id_ed25519",
      cwd: "/srv/work",
      syncFiles: false,
      persistentShell: false,
    });
  });

  it("allows edit upserts to omit the redacted identity file", () => {
    expect(
      decodeUpsert({
        endpointId: "build-host",
        endpoint: {
          displayName: "Build host",
          enabled: true,
          host: "builder.internal",
          user: "aeris",
          cwd: "/srv/work",
        },
      }),
    ).toEqual({
      endpointId: "build-host",
      endpoint: {
        displayName: "Build host",
        enabled: true,
        host: "builder.internal",
        user: "aeris",
        port: 22,
        cwd: "/srv/work",
      },
    });
  });
});
