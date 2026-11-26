/**
 * When the user last saw each linked Hermes conversation, kept in `hermes-chat-seen.json` under
 * the server's state dir so every device shares it. Read field by field: one bad entry, a hand
 * edit, or a newer build's extra field costs only that entry.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const HERMES_CHAT_SEEN_FILENAME = "hermes-chat-seen.json";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Session key → ISO last-seen time. Anything unreadable reads as "never seen". */
export function parseHermesChatSeen(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  const json = Option.getOrNull(decodeJson(raw));
  if (!isRecord(json) || !isRecord(json.seen)) return result;
  for (const [sessionKey, value] of Object.entries(json.seen)) {
    const key = sessionKey.trim();
    if (!key || typeof value !== "string" || !Number.isFinite(Date.parse(value))) continue;
    result.set(key, value);
  }
  return result;
}

/** Keys sorted, so the file diffs cleanly between writes. */
export function serializeHermesChatSeen(seen: ReadonlyMap<string, string>): string {
  const sorted = Object.fromEntries([...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ version: 1, seen: sorted }, null, 2)}\n`;
}
