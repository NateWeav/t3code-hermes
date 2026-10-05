import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const hub = (managementKey: string, enabled = true) => ({
  hub: { kind: "cliproxy", url: "http://hub.test:8317", managementKey, enabled },
});

describe("UsageLimitSources", () => {
  it.effect("does not retry a rejected management key until the source changes", () => {
    const attempts: Array<string | undefined> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "invalid management key" }, { status: 401 }),
        );
      }),
    );
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      const settings = yield* ServerSettingsService;

      yield* sources.refresh;
      yield* sources.refresh;
      expect(attempts).toEqual(["Bearer wrong"]);
      expect((yield* sources.current)[0]?.error).toContain("rejected the management key");

      yield* settings.updateSettings({ usageLimitSources: hub("fixed") });
      yield* sources.refresh;
      expect(attempts).toEqual(["Bearer wrong", "Bearer fixed"]);

      // Turning the source off and on is the way to retry an unchanged key.
      yield* settings.updateSettings({ usageLimitSources: hub("fixed", false) });
      yield* sources.refresh;
      yield* settings.updateSettings({ usageLimitSources: hub("fixed") });
      yield* sources.refresh;
      expect(attempts).toEqual(["Bearer wrong", "Bearer fixed", "Bearer fixed"]);
    }).pipe(
      Effect.provide(
        UsageLimitSources.layer.pipe(
          Layer.provideMerge(ServerSettingsService.layerTest({ usageLimitSources: hub("wrong") })),
          Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      ),
    );
  });
});
