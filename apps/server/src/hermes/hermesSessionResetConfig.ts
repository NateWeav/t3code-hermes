/**
 * Lists the vendored session-reset plugin under `plugins.enabled` while its patch is applied: Hermes
 * loads no bundled plugin until enabled. A marker comment lets removal take out only T3 Code's entry;
 * a user's own `enabled`/`disabled` entry stands. Never rewrites an unparseable file.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
} from "yaml";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

/** The plugin's `name` in its `plugin.yaml`, which `plugins.enabled` lists. */
const PLUGIN_NAME = "hermes-session-reset-policy";
/** Trailing comment that marks an entry T3 Code wrote. */
const MARKER = " added by T3 Code (Session reset policy patch)";

function listedIn(document: Document, key: "enabled" | "disabled"): YAMLSeq | null {
  const list: unknown = document.getIn(["plugins", key], true);
  return isSeq(list) ? list : null;
}

function entryIndex(list: YAMLSeq | null): number {
  if (list === null) return -1;
  return list.items.findIndex((item) => isScalar(item) && item.value === PLUGIN_NAME);
}

/** Lists the plugin under `plugins.enabled`, unless the user already listed or disabled it. */
export function markSessionResetPlugin(document: Document): number {
  if (entryIndex(listedIn(document, "disabled")) !== -1) return 0;
  const plugins: unknown = document.get("plugins", true);
  if (plugins !== undefined && plugins !== null && !isMap(plugins)) return 0;
  const enabledNode: unknown = isMap(plugins) ? plugins.get("enabled", true) : undefined;
  if (enabledNode !== undefined && enabledNode !== null && !isSeq(enabledNode)) return 0;
  if (entryIndex(isSeq(enabledNode) ? enabledNode : null) !== -1) return 0;
  const map = isMap(plugins) ? plugins : new YAMLMap();
  if (!isMap(plugins)) document.set("plugins", map);
  const enabled = isSeq(enabledNode) ? enabledNode : new YAMLSeq();
  if (!isSeq(enabledNode)) map.set("enabled", enabled);
  // A flow sequence with a trailing comment renders across several lines anyway.
  enabled.flow = false;
  const entry = new Scalar(PLUGIN_NAME);
  entry.comment = MARKER;
  enabled.items.push(entry);
  return 1;
}

/** Removes the entry T3 Code added, and a `plugins.enabled` list left empty by it. */
export function unmarkSessionResetPlugin(document: Document): number {
  const enabled = listedIn(document, "enabled");
  const index = entryIndex(enabled);
  if (enabled === null || index === -1) return 0;
  const entry = enabled.items[index];
  if (!isScalar(entry) || entry.comment !== MARKER) return 0;
  enabled.items.splice(index, 1);
  if (enabled.items.length === 0) document.deleteIn(["plugins", "enabled"]);
  return 1;
}

/**
 * Applies `edit` to `config.yaml` and writes it back when it changed anything.
 * Never fails the caller: the patch change already happened, and a config T3
 * Code could not read or write is left exactly as it was.
 */
const editHermesConfig = Effect.fn("hermesSessionResetConfig.editHermesConfig")(function* (
  configFile: string,
  edit: (document: Document) => number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(configFile).pipe(Effect.orElseSucceed(() => null));
  if (text === null) return 0;
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    yield* Effect.logWarning(
      "Hermes config.yaml did not parse; the session reset plugin was not configured.",
    );
    return 0;
  }
  const changed = edit(document);
  if (changed === 0) return 0;
  const written = yield* writeFileStringAtomically({
    filePath: configFile,
    contents: document.toString(),
  }).pipe(Effect.result);
  if (Result.isFailure(written)) {
    yield* Effect.logWarning("Could not write Hermes config.yaml for the session reset plugin.", {
      cause: written.failure._tag,
    });
    return 0;
  }
  return changed;
});

/** Turns the session reset plugin on in Hermes's config. */
export const enableHermesSessionResetPlugin = (configFile: string) =>
  editHermesConfig(configFile, markSessionResetPlugin);

/** Takes back the plugin entry T3 Code added. */
export const disableHermesSessionResetPlugin = (configFile: string) =>
  editHermesConfig(configFile, unmarkSessionResetPlugin);
