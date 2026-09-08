// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { readOpenCodeGoUsageLimits } from "./openCodeGoUsageLimits.ts";

const client = (respond: (url: string) => Response) =>
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request.url))),
  );

describe("OpenCode Go provider limits", () => {
  it.effect("publishes dashboard windows in the shared provider format", () =>
    Effect.gen(function* () {
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { OPENCODE_GO_AUTH_COOKIE: "fixture", OPENCODE_GO_WORKSPACE_ID: "wrk_test" },
        isExternalServer: true,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          client((url) => {
            expect(url).toBe("https://opencode.ai/workspace/wrk_test/go");
            return Response.json({ rolling: { percent: 25 }, weekly: { percent: 50 } });
          }),
        ),
      );
      expect(limits.windows).toMatchObject([
        { id: "five-hour", kind: "session", usedPercent: 25 },
        { id: "weekly", kind: "weekly", usedPercent: 50 },
      ]);
      expect(limits.unavailable).toBeUndefined();
    }),
  );

  it.effect(
    "marks failed dashboard reads as probe failures for upstream stale-value handling",
    () =>
      Effect.gen(function* () {
        const limits = yield* readOpenCodeGoUsageLimits({
          environment: { OPENCODE_GO_AUTH_COOKIE: "fixture", OPENCODE_GO_WORKSPACE_ID: "wrk_test" },
          isExternalServer: true,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            client(() => new Response("", { status: 503 })),
          ),
        );
        expect(limits.unavailable?.reason).toBe("probeFailed");
      }),
  );

  it.effect("never uses host credentials for an external OpenCode server", () =>
    Effect.gen(function* () {
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: {},
        isExternalServer: true,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          client(() => {
            throw new Error("Unexpected request");
          }),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("reads the API with instance-local credentials", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-go-limits-"))),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      NodeFS.mkdirSync(NodePath.join(directory, "opencode"));
      NodeFS.writeFileSync(
        NodePath.join(directory, "opencode", "auth.json"),
        '{"opencode-go":{"key":"fixture"}}',
      );
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { XDG_DATA_HOME: directory },
        isExternalServer: false,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          client((url) => {
            expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
            return Response.json({ monthly: { percent: 12 } });
          }),
        ),
      );
      expect(limits.windows).toMatchObject([{ kind: "monthly", usedPercent: 12 }]);
    }).pipe(Effect.scoped),
  );
});
