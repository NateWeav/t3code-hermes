// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { readOpenCodeGoApiKey, readOpenCodeGoLocalQuota } from "./openCodeGoLocal.ts";
import { parseOpenCodeGoDocument, parseOpenCodeGoUsage } from "./openCodeGoReaders.ts";
import { makeUnavailableUsageLimits, makeUsageLimits } from "./providerUsageLimits.ts";

/** Reads Go limits during the instance probe; upstream snapshots own refresh and stale values. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly isExternalServer: boolean;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const now = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(now);
  const nowMs = DateTime.toEpochMillis(now);
  const value = (name: string) => input.environment[name]?.trim() || undefined;
  const unavailable = (reason: "unsupported" | "probeFailed", message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason, message });
  const cookie = value("OPENCODE_GO_AUTH_COOKIE");
  const workspaceId = value("OPENCODE_GO_WORKSPACE_ID");
  if (cookie && workspaceId) {
    if (!/^wrk_[A-Za-z0-9]+$/.test(workspaceId)) {
      return unavailable("unsupported", "The configured OpenCode Go workspace id is invalid.");
    }
    const result = yield* Effect.result(
      httpClient
        .execute(
          HttpClientRequest.get(`https://opencode.ai/workspace/${workspaceId}/go`).pipe(
            HttpClientRequest.setHeader("accept", "text/html,application/json"),
            HttpClientRequest.setHeader("cookie", cookie),
            HttpClientRequest.setHeader("user-agent", "Mozilla/5.0 T3Code/1.0"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text),
          Effect.timeout("10 seconds"),
        ),
    );
    const windows = Result.isSuccess(result)
      ? parseOpenCodeGoUsage(parseOpenCodeGoDocument(result.success, nowMs), nowMs)
      : [];
    return windows.length > 0
      ? makeUsageLimits({ checkedAt, windows })
      : unavailable("probeFailed", "OpenCode Go dashboard limits could not be read.");
  }

  // A remote OpenCode server does not share this environment's credentials or history.
  if (input.isExternalServer) {
    return unavailable(
      "unsupported",
      "Configure the OpenCode Go dashboard source for a remote OpenCode server.",
    );
  }
  const dataRoot = value("XDG_DATA_HOME") ?? NodePath.join(NodeOS.homedir(), ".local", "share");
  const openCodeDir = NodePath.join(dataRoot, "opencode");
  const authPath = NodePath.join(openCodeDir, "auth.json");
  const apiKey = readOpenCodeGoApiKey(authPath);
  if (apiKey === null) {
    return unavailable("unsupported", "Sign in with OpenCode Go to show plan limits.");
  }
  const result = yield* Effect.result(
    httpClient
      .execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
          HttpClientRequest.setHeader("user-agent", "T3Code/1.0"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("10 seconds"),
      ),
  );
  if (Result.isSuccess(result)) {
    const windows = parseOpenCodeGoUsage(result.success, nowMs);
    if (windows.length > 0) return makeUsageLimits({ checkedAt, windows });
  }
  const configuredDatabase = value("OPENCODE_DB");
  const databasePath = configuredDatabase
    ? NodePath.isAbsolute(configuredDatabase)
      ? configuredDatabase
      : NodePath.join(openCodeDir, configuredDatabase)
    : NodePath.join(openCodeDir, "opencode.db");
  const local = readOpenCodeGoLocalQuota({ authPath, databasePath, nowMs });
  return local.windows.length > 0
    ? makeUsageLimits({ checkedAt, windows: local.windows })
    : unavailable(
        "probeFailed",
        "OpenCode Go limits could not be read and no local history was found.",
      );
});
