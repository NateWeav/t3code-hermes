import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  hermesKanbanIconProblem,
  parseHermesKanbanPreferences,
  serializeHermesKanbanPreferences,
  withHermesKanbanPreference,
} from "./hermesKanbanPreferences.ts";

const PROJECT = ProjectId.make("project-a");
const base64 = (bytes: readonly number[] | string) =>
  Buffer.from(typeof bytes === "string" ? bytes : Uint8Array.from(bytes)).toString("base64");
const PNG = {
  dataUrl: `data:image/png;base64,${base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])}`,
  mimeType: "image/png" as const,
};
const SVG = {
  dataUrl: `data:image/svg+xml;base64,${base64('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')}`,
  mimeType: "image/svg+xml" as const,
};

describe("parseHermesKanbanPreferences", () => {
  it("round-trips through the serialized file", () => {
    const preferences = withHermesKanbanPreference(
      withHermesKanbanPreference(new Map(), "zeta", { projectId: PROJECT }),
      "alpha",
      { icon: PNG },
    );
    const raw = serializeHermesKanbanPreferences(preferences);
    expect(Object.keys(JSON.parse(raw).boards)).toEqual(["alpha", "zeta"]);
    expect(parseHermesKanbanPreferences(raw)).toEqual(preferences);
  });

  it("decodes entries with missing fields and skips broken ones", () => {
    const raw = JSON.stringify({
      boards: {
        onlyProject: { projectId: PROJECT },
        onlyIcon: { icon: SVG },
        empty: {},
        badIcon: {
          projectId: PROJECT,
          icon: { dataUrl: "javascript:alert(1)", mimeType: "image/png" },
        },
        wrongType: { icon: { dataUrl: PNG.dataUrl, mimeType: "text/html" } },
        notAnObject: 3,
      },
    });
    const parsed = parseHermesKanbanPreferences(raw);
    expect([...parsed.keys()].sort()).toEqual(["badIcon", "onlyIcon", "onlyProject"]);
    expect(parsed.get("onlyProject")).toEqual({ projectId: PROJECT });
    expect(parsed.get("onlyIcon")).toEqual({ icon: SVG });
    expect(parsed.get("badIcon")).toEqual({ projectId: PROJECT });
  });

  it("reads garbage or the wrong shape as no preferences", () => {
    expect(parseHermesKanbanPreferences("not json").size).toBe(0);
    expect(parseHermesKanbanPreferences("[]").size).toBe(0);
    expect(parseHermesKanbanPreferences('{"boards":[]}').size).toBe(0);
  });
});

describe("withHermesKanbanPreference", () => {
  it("changes one field, keeps the other, and drops a board left empty", () => {
    const linked = withHermesKanbanPreference(new Map(), "b", { projectId: PROJECT, icon: PNG });
    const unlinked = withHermesKanbanPreference(linked, "b", { projectId: null });
    expect(unlinked.get("b")).toEqual({ icon: PNG });
    expect(withHermesKanbanPreference(unlinked, "b", { icon: null }).has("b")).toBe(false);
    // The input map is left alone.
    expect(linked.get("b")).toEqual({ projectId: PROJECT, icon: PNG });
  });
});

describe("hermesKanbanIconProblem", () => {
  it("accepts matching raster and SVG data URLs", () => {
    expect(hermesKanbanIconProblem(PNG)).toBeNull();
    expect(hermesKanbanIconProblem(SVG)).toBeNull();
    expect(
      hermesKanbanIconProblem({
        dataUrl: `data:image/webp;base64,${base64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])}`,
        mimeType: "image/webp",
      }),
    ).toBeNull();
  });

  it("refuses a mismatched media type, bad base64, wrong bytes, and oversize", () => {
    expect(
      hermesKanbanIconProblem({ dataUrl: PNG.dataUrl, mimeType: "image/jpeg" }),
    ).not.toBeNull();
    expect(
      hermesKanbanIconProblem({ dataUrl: "data:image/png;base64,@@@@", mimeType: "image/png" }),
    ).not.toBeNull();
    expect(
      hermesKanbanIconProblem({
        dataUrl: `data:image/svg+xml;base64,${base64("hello")}`,
        mimeType: "image/svg+xml",
      }),
    ).not.toBeNull();
    const big = new Uint8Array(256 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(
      hermesKanbanIconProblem({
        dataUrl: `data:image/jpeg;base64,${Buffer.from(big).toString("base64")}`,
        mimeType: "image/jpeg",
      }),
    ).toContain("larger");
  });
});
