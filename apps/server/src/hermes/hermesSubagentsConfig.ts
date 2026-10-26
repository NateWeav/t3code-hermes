/**
 * Hermes has no per-session or ACP-only way to drop a toolset, so this edits the global
 * `agent.disabled_toolsets`. Our entry carries a comment marker (Hermes's ruamel saves keep
 * comments), so turning the setting off never removes a `delegation` entry the user wrote.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveHermesReasoningPaths } from "./hermesReasoning.ts";

const PATH = ["agent", "disabled_toolsets"] as const;
const TOOLSET = "delegation";
const MARKER = " managed by T3 Code (Use T3 Code subagents only)";

type HermesSubagentsConfigOutcome =
  | { readonly _tag: "written" }
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "readFailed"; readonly detail: string }
  | { readonly _tag: "parseFailed"; readonly detail: string }
  /** `disabled_toolsets` is a string or other non-list value, left as the user wrote it. */
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "writeFailed"; readonly detail: string };

function pruneEmpty(document: Document) {
  const list = document.getIn(PATH, true);
  if (isSeq(list) && list.items.length === 0) document.deleteIn(PATH);
  const agent = document.getIn(["agent"], true);
  if (isMap(agent) && agent.items.length === 0) document.deleteIn(["agent"]);
}

export const writeHermesT3SubagentsOnly = Effect.fn(
  "hermesSubagentsConfig.writeHermesT3SubagentsOnly",
)(function* (input: {
  readonly configFile: string;
  readonly enabled: boolean;
}): Effect.fn.Return<HermesSubagentsConfigOutcome, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const read = yield* fs.readFileString(input.configFile).pipe(Effect.result);
  if (Result.isFailure(read) && read.failure.reason._tag !== "NotFound") {
    return { _tag: "readFailed", detail: read.failure.reason._tag } as const;
  }
  const existing = Result.isSuccess(read) ? read.success : null;
  if (existing === null && !input.enabled) return { _tag: "unchanged" } as const;

  const document = parseDocument(existing ?? "");
  if (document.errors.length > 0) {
    return {
      _tag: "parseFailed",
      detail: document.errors[0]?.message ?? "unknown YAML parse error",
    } as const;
  }

  const list = document.getIn(PATH, true);
  if (list !== undefined && list !== null && !isSeq(list)) return { _tag: "unsupported" } as const;
  const items = isSeq(list) ? list.items : [];
  const isDelegation = (item: unknown) => isScalar(item) && item.value === TOOLSET;
  const ours = items.findIndex(
    (item) => isScalar(item) && item.value === TOOLSET && item.comment?.trim() === MARKER.trim(),
  );

  if (input.enabled) {
    if (items.some(isDelegation)) return { _tag: "unchanged" } as const;
    const entry = document.createNode(TOOLSET);
    entry.comment = MARKER;
    if (isSeq(list)) list.items.push(entry);
    else document.setIn(PATH, document.createNode([entry]));
  } else {
    if (ours === -1) return { _tag: "unchanged" } as const;
    document.deleteIn([...PATH, ours]);
    pruneEmpty(document);
  }

  const written = yield* writeFileStringAtomically({
    filePath: input.configFile,
    contents: document.toString(),
  }).pipe(Effect.result);
  if (Result.isFailure(written)) {
    return { _tag: "writeFailed", detail: written.failure._tag } as const;
  }
  return { _tag: "written" } as const;
});

/** Applies the setting to the instance's `HERMES_HOME`; never fails the caller. */
export const applyHermesT3SubagentsOnly = Effect.fn(
  "hermesSubagentsConfig.applyHermesT3SubagentsOnly",
)(function* (input: { readonly environment: NodeJS.ProcessEnv; readonly enabled: boolean }) {
  const { configFile } = resolveHermesReasoningPaths(input.environment);
  const outcome = yield* writeHermesT3SubagentsOnly({ configFile, enabled: input.enabled });
  if (outcome._tag !== "written" && outcome._tag !== "unchanged") {
    yield* Effect.logWarning("Could not update Hermes's subagent setting in config.yaml.", {
      outcome: outcome._tag,
      ...("detail" in outcome ? { detail: outcome.detail } : {}),
      configFile,
    });
  }
  return outcome;
});
