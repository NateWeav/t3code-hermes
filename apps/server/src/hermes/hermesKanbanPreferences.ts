/**
 * T3 Code's own per-board preferences for Hermes Kanban boards: a linked T3 project and an
 * uploaded icon. Kept in `hermes-kanban-boards.json` under the server's state dir, never in
 * Hermes: a Hermes board's own `project_id` points at Hermes's `projects.db`, not at T3 projects.
 */
import {
  HERMES_KANBAN_BOARD_ICON_MAX_BYTES,
  HermesKanbanBoardIconMimeType,
  ProjectId,
  type HermesKanbanBoardIcon,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const HERMES_KANBAN_PREFERENCES_FILENAME = "hermes-kanban-boards.json";

export interface HermesKanbanBoardPreference {
  readonly projectId?: ProjectId;
  readonly icon?: HermesKanbanBoardIcon;
}

export type HermesKanbanPreferenceMap = ReadonlyMap<string, HermesKanbanBoardPreference>;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeProjectId = Schema.decodeUnknownOption(ProjectId);
const decodeMimeType = Schema.decodeUnknownOption(HermesKanbanBoardIconMimeType);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

/** The first bytes match the claimed raster format; SVG is text and checked separately. */
function rasterSignatureMatches(mimeType: HermesKanbanBoardIcon["mimeType"], bytes: Uint8Array) {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case "image/svg+xml":
      return true;
  }
}

/**
 * Why an icon is refused (wrong media type, bad base64, over the cap, bytes not that format), or
 * null. SVG is safe only because clients render board icons solely via `<img src>`, where an SVG
 * runs no script and loads nothing external. Inlining one (innerHTML, <svg>, <object>) is XSS.
 */
export function hermesKanbanIconProblem(icon: HermesKanbanBoardIcon): string | null {
  const prefix = `data:${icon.mimeType};base64,`;
  if (!icon.dataUrl.startsWith(prefix)) {
    return "The icon must be a base64 data URL of the declared image type.";
  }
  const payload = icon.dataUrl.slice(prefix.length);
  if (payload.length === 0 || payload.length % 4 !== 0 || !BASE64.test(payload)) {
    return "The icon is not valid base64.";
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  if ((payload.length / 4) * 3 - padding > HERMES_KANBAN_BOARD_ICON_MAX_BYTES) {
    return `The icon is larger than ${HERMES_KANBAN_BOARD_ICON_MAX_BYTES / 1024} KB.`;
  }
  const bytes = Buffer.from(payload, "base64");
  if (icon.mimeType === "image/svg+xml") {
    const head = bytes
      .subarray(0, 1024)
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (!head.startsWith("<") || !/<svg[\s>]/i.test(bytes.toString("utf8"))) {
      return "The icon is not an SVG document.";
    }
    return null;
  }
  return rasterSignatureMatches(icon.mimeType, bytes)
    ? null
    : "The icon's contents do not match its image type.";
}

function decodeIcon(value: unknown): HermesKanbanBoardIcon | null {
  if (!isRecord(value) || typeof value.dataUrl !== "string") return null;
  const mimeType = decodeMimeType(value.mimeType);
  if (Option.isNone(mimeType)) return null;
  const icon = { dataUrl: value.dataUrl, mimeType: mimeType.value };
  return hermesKanbanIconProblem(icon) === null ? icon : null;
}

/**
 * Field by field, so a file from an older or newer build, a hand edit, or one bad entry never
 * costs the other boards their preferences. Anything unreadable reads as "no preference".
 */
export function parseHermesKanbanPreferences(
  raw: string,
): Map<string, HermesKanbanBoardPreference> {
  const result = new Map<string, HermesKanbanBoardPreference>();
  const json = Option.getOrNull(decodeJson(raw));
  if (!isRecord(json) || !isRecord(json.boards)) return result;
  for (const [slug, entry] of Object.entries(json.boards)) {
    if (!isRecord(entry)) continue;
    const projectId = Option.getOrNull(decodeProjectId(entry.projectId));
    const icon = decodeIcon(entry.icon);
    const preference: HermesKanbanBoardPreference = {
      ...(projectId === null ? {} : { projectId }),
      ...(icon === null ? {} : { icon }),
    };
    if (preference.projectId !== undefined || preference.icon !== undefined) {
      result.set(slug, preference);
    }
  }
  return result;
}

export function serializeHermesKanbanPreferences(preferences: HermesKanbanPreferenceMap): string {
  const boards: Record<string, HermesKanbanBoardPreference> = {};
  for (const slug of [...preferences.keys()].sort()) {
    const preference = preferences.get(slug);
    if (preference !== undefined) boards[slug] = preference;
  }
  return `${JSON.stringify({ version: 1, boards }, null, 2)}\n`;
}

/** The map with one board's preference replaced; a board left with nothing is dropped. */
export function withHermesKanbanPreference(
  preferences: HermesKanbanPreferenceMap,
  slug: string,
  change: {
    readonly projectId?: ProjectId | null;
    readonly icon?: HermesKanbanBoardIcon | null;
  },
): Map<string, HermesKanbanBoardPreference> {
  const next = new Map(preferences);
  const current = preferences.get(slug) ?? {};
  const projectId = change.projectId === undefined ? current.projectId : change.projectId;
  const icon = change.icon === undefined ? current.icon : change.icon;
  const preference: HermesKanbanBoardPreference = {
    ...(projectId == null ? {} : { projectId }),
    ...(icon == null ? {} : { icon }),
  };
  if (preference.projectId === undefined && preference.icon === undefined) next.delete(slug);
  else next.set(slug, preference);
  return next;
}
