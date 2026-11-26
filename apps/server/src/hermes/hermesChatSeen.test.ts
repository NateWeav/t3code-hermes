import { describe, expect, it } from "@effect/vitest";

import { parseHermesChatSeen, serializeHermesChatSeen } from "./hermesChatSeen.ts";

describe("hermes chat seen file", () => {
  it("keeps every readable entry and drops the rest", () => {
    const seen = parseHermesChatSeen(
      JSON.stringify({
        version: 1,
        seen: {
          "agent:b": "2026-11-27T10:00:00.000Z",
          "agent:a": "2026-11-26T10:00:00.000Z",
          "agent:bad-date": "yesterday",
          "agent:number": 5,
          " ": "2026-11-27T10:00:00.000Z",
        },
        extra: "from a newer build",
      }),
    );
    expect([...seen]).toEqual([
      ["agent:b", "2026-11-27T10:00:00.000Z"],
      ["agent:a", "2026-11-26T10:00:00.000Z"],
    ]);
    expect(parseHermesChatSeen("").size).toBe(0);
    expect(parseHermesChatSeen("not json").size).toBe(0);
    expect(parseHermesChatSeen(JSON.stringify({ seen: [] })).size).toBe(0);
  });

  it("writes keys sorted and reads them back", () => {
    const text = serializeHermesChatSeen(
      new Map([
        ["agent:b", "2026-11-27T10:00:00.000Z"],
        ["agent:a", "2026-11-26T10:00:00.000Z"],
      ]),
    );
    expect(Object.keys(JSON.parse(text).seen)).toEqual(["agent:a", "agent:b"]);
    expect(JSON.parse(text).version).toBe(1);
    expect([...parseHermesChatSeen(text)].sort()).toEqual([
      ["agent:a", "2026-11-26T10:00:00.000Z"],
      ["agent:b", "2026-11-27T10:00:00.000Z"],
    ]);
  });
});
