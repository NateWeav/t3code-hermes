/**
 * Reads usage exported from machines this server cannot scan, such as a laptop whose
 * transcripts are gone. Each `<stateDir>/usage-imports/*.json` file adds one source per provider
 * under its own host; deleting the file removes its usage.
 */
import { NonNegativeInt, TrimmedNonEmptyString, UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const USAGE_IMPORTS_DIR_NAME = "usage-imports";

const UsageImportRecord = Schema.Struct({
  provider: UsageProviderKind,
  timestamp: Schema.String,
  model: TrimmedNonEmptyString,
  sessionId: Schema.optional(Schema.String),
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: Schema.optional(NonNegativeInt),
  /** The provider's native key, so the same response read from a transcript here counts once. */
  dedupeKey: Schema.optional(Schema.String),
});

const UsageImportFile = Schema.Struct({
  version: Schema.Literal(1),
  /** The machine the usage ran on, so clients keep it apart from this server's own. */
  hostId: TrimmedNonEmptyString,
  records: Schema.Array(UsageImportRecord),
});

const decodeImportFile = Schema.decodeUnknownOption(Schema.fromJsonString(UsageImportFile));

export interface ImportedUsageSource {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly hostId?: string;
  readonly status?: "failed";
  readonly message?: string;
  readonly files: readonly {
    readonly path: string;
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: readonly number[];
  }[];
}

/** One source per provider, or null when any part of the file is invalid. */
function parseUsageImport(filePath: string, raw: string): readonly ImportedUsageSource[] | null {
  const file = decodeImportFile(raw);
  if (Option.isNone(file)) return null;
  const byProvider = new Map<UsageProviderKind, UsageRecord[]>();
  for (const { provider, timestamp, model, sessionId, dedupeKey, ...tokens } of file.value
    .records) {
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) return null;
    const records = byProvider.get(provider) ?? [];
    byProvider.set(provider, records);
    records.push({
      provider,
      timestampMs,
      model,
      sessionId: sessionId ?? "",
      totals: {
        uncachedInputTokens: tokens.uncachedInputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        outputTokens: tokens.outputTokens,
        reasoningTokens: tokens.reasoningTokens ?? 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: dedupeKey ?? null,
    });
  }
  return [...byProvider].map(([provider, records]) => ({
    provider,
    dir: filePath,
    hostId: file.value.hostId,
    files: [{ path: filePath, records, malformedRecords: [] }],
  }));
}

export const readUsageImports = Effect.fn("readUsageImports")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(stateDir, USAGE_IMPORTS_DIR_NAME);
  const names = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
  const sources: ImportedUsageSource[] = [];
  for (const name of names.filter((name) => name.endsWith(".json")).toSorted()) {
    const filePath = path.join(dir, name);
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
    const parsed = raw === null ? null : parseUsageImport(filePath, raw);
    sources.push(
      ...(parsed ?? [
        {
          provider: "claude",
          dir: filePath,
          status: "failed",
          message: `Usage import ${name} is not a valid version 1 import and was skipped.`,
          files: [],
        } satisfies ImportedUsageSource,
      ]),
    );
  }
  return sources;
});
