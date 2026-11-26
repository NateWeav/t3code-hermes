import { GLASS_SURFACE_OPAQUE, type GlassSurfaces } from "@t3tools/contracts/settings";

// Fork: translucent app surfaces over the theme background image. The root
// gets `data-glass-surfaces` listing every surface that is see-through, and one
// opacity variable per surface; index.css does the painting. No attribute means
// upstream's look, untouched.

const GLASS_SURFACE_TOKENS = {
  sidebar: "sidebar",
  chatHeader: "chat-header",
  chatArea: "chat-area",
  composer: "composer",
  threadDetails: "thread-details",
  menus: "menus",
  floatingControls: "floating-controls",
  dialogs: "dialogs",
} as const satisfies Record<Exclude<keyof GlassSurfaces, "enabled" | "blur">, string>;

type GlassSurfaceKey = keyof typeof GLASS_SURFACE_TOKENS;

export const GLASS_SURFACE_KEYS = Object.keys(GLASS_SURFACE_TOKENS) as GlassSurfaceKey[];

interface GlassSurfaceRootState {
  /** Space-separated tokens for `data-glass-surfaces`, or null to remove it. */
  readonly surfaces: string | null;
  readonly variables: Readonly<Record<string, string>>;
}

export function resolveGlassSurfaceRootState(settings: GlassSurfaces): GlassSurfaceRootState {
  if (!settings.enabled) return { surfaces: null, variables: {} };
  const glass = GLASS_SURFACE_KEYS.filter((key) => settings[key] < GLASS_SURFACE_OPAQUE);
  if (glass.length === 0) return { surfaces: null, variables: {} };
  const variables: Record<string, string> = { "--glass-surface-blur": `${settings.blur}px` };
  for (const key of glass) {
    variables[`--glass-${GLASS_SURFACE_TOKENS[key]}-opacity`] = `${settings[key]}%`;
  }
  return { surfaces: glass.map((key) => GLASS_SURFACE_TOKENS[key]).join(" "), variables };
}

let appliedVariables: readonly string[] = [];

export function applyGlassSurfaces(root: HTMLElement, settings: GlassSurfaces): void {
  const next = resolveGlassSurfaceRootState(settings);
  for (const name of appliedVariables) root.style.removeProperty(name);
  appliedVariables = Object.keys(next.variables);
  for (const [name, value] of Object.entries(next.variables)) root.style.setProperty(name, value);
  if (next.surfaces === null) delete root.dataset.glassSurfaces;
  else root.dataset.glassSurfaces = next.surfaces;
}
