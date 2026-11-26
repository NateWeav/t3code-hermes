import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveGlassSurfaceRootState } from "./glassSurfaces";

const defaults = DEFAULT_CLIENT_SETTINGS.glassSurfaces;

describe("resolveGlassSurfaceRootState", () => {
  it("leaves the root untouched while the feature is off", () => {
    expect(defaults.enabled).toBe(false);
    expect(resolveGlassSurfaceRootState(defaults)).toEqual({ surfaces: null, variables: {} });
  });

  it("lists every see-through surface and its opacity", () => {
    const state = resolveGlassSurfaceRootState({ ...defaults, enabled: true, blur: 18 });
    expect(state.surfaces).toBe(
      "sidebar chat-header chat-area composer thread-details menus floating-controls dialogs",
    );
    expect(state.variables["--glass-surface-blur"]).toBe("18px");
    expect(state.variables["--glass-sidebar-opacity"]).toBe(`${defaults.sidebar}%`);
  });

  it("skips a surface set to opaque so it keeps upstream's fill", () => {
    const state = resolveGlassSurfaceRootState({ ...defaults, enabled: true, sidebar: 100 });
    expect(state.surfaces?.split(" ")).not.toContain("sidebar");
    expect(state.variables).not.toHaveProperty("--glass-sidebar-opacity");
  });

  it("removes the attribute when every surface is opaque", () => {
    const opaque = { ...defaults, enabled: true };
    for (const key of [
      "sidebar",
      "chatHeader",
      "chatArea",
      "composer",
      "threadDetails",
      "menus",
      "floatingControls",
      "dialogs",
    ] as const) {
      opaque[key] = 100;
    }
    expect(resolveGlassSurfaceRootState(opaque).surfaces).toBeNull();
  });
});
