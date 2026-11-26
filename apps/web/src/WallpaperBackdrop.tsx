import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as Schema from "effect/Schema";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useClientSettings } from "./hooks/useSettings";
import { syncBrowserChromeTheme } from "./hooks/useTheme";
import { screenIndexForPoint, wallpaperViewportRect, type DipScreen } from "./wallpaperBackdrop";

// Fork feature: paint the spanned desktop wallpaper behind see-through app
// surfaces so a maximized browser window looks transparent. The wallpaper image
// stays in this browser's local storage; nothing is sent to the server.

const WALLPAPER_STORAGE_KEY = "t3code:wallpaper:v1";
/** localStorage quotas are ~10 MB, and a data URL is ~4/3 the file size. */
export const WALLPAPER_MAX_IMAGE_BYTES = 7 * 1024 * 1024;

const WallpaperImage = Schema.Struct({
  mimeType: Schema.String,
  dataUrl: Schema.String,
});
type WallpaperImage = typeof WallpaperImage.Type;
const StoredWallpaper = Schema.NullOr(WallpaperImage);

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the file.")));
    reader.readAsDataURL(blob);
  });
}

/**
 * Settings-panel state for the stored wallpaper. Writes go through
 * `setLocalStorageItem` directly so a full quota surfaces as an error instead
 * of the silent console log inside `useLocalStorage`'s writer.
 */
export function useWallpaperBackdropState() {
  const [stored, setStored] = useLocalStorage(WALLPAPER_STORAGE_KEY, null, StoredWallpaper);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "reading">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stored === null) {
      setImageSize(null);
      return;
    }
    const image = new Image();
    image.addEventListener("load", () => {
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    });
    image.src = stored.dataUrl;
    return () => {
      image.src = "";
    };
  }, [stored]);

  const chooseWallpaper = useEffectEvent(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (file.size > WALLPAPER_MAX_IMAGE_BYTES) {
      setError("That image is over 7 MB. Save it as a JPG to stay under the browser storage limit.");
      return;
    }
    setStatus("reading");
    setError(null);
    try {
      const dataUrl = await blobToDataUrl(file);
      setLocalStorageItem(WALLPAPER_STORAGE_KEY, { mimeType: file.type, dataUrl }, StoredWallpaper);
      setStored({ mimeType: file.type, dataUrl });
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the wallpaper.");
      setStatus("idle");
    }
  });

  return {
    stored,
    imageSize,
    status,
    error,
    chooseWallpaper,
    clearWallpaper: () => setStored(null),
  } as const;
}

// --- Window placement -------------------------------------------------------
//
// Chromium reports `window.screenX/Y` in the same virtual-desktop coordinates
// as the Window Management API's screens, which is what makes the placement
// math possible. The API itself needs a permission prompt on first use, so
// before it is granted we fall back to a single-screen layout measured from
// `window.screen` and retry on the next user gesture.

export type WindowManagementStatus = "ready" | "single-screen";

interface WindowManagementSnapshot {
  readonly status: WindowManagementStatus;
  readonly screens: readonly DipScreen[];
  readonly screenIndex: number;
  readonly viewportLeft: number;
  readonly viewportTop: number;
}

declare global {
  interface ScreenDetailsLike {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
    readonly isPrimary: boolean;
  }
  interface Window {
    readonly getScreenDetails?: () => Promise<{ readonly screens: readonly ScreenDetailsLike[] }>;
  }
}

let snapshot: WindowManagementSnapshot | null = null;
let refreshInFlight = false;
const snapshotListeners = new Set<() => void>();

/** Stable before the first refresh and on the server, so getSnapshot is cached. */
const INITIAL_SNAPSHOT: WindowManagementSnapshot = {
  status: "single-screen",
  screens: [],
  screenIndex: 0,
  viewportLeft: 0,
  viewportTop: 0,
};

const emitSnapshot = () => {
  for (const listener of snapshotListeners) listener();
};

const subscribeSnapshot = (onStoreChange: () => void) => {
  snapshotListeners.add(onStoreChange);
  return () => snapshotListeners.delete(onStoreChange);
};

function singleScreenSnapshot(): WindowManagementSnapshot {
  return {
    status: "single-screen",
    screens: [
      {
        left: 0,
        top: 0,
        width: window.screen.width,
        height: window.screen.height,
        devicePixelRatio: window.devicePixelRatio,
      },
    ],
    screenIndex: 0,
    viewportLeft: window.screenX,
    viewportTop: window.screenY + Math.max(0, window.outerHeight - window.innerHeight),
  };
}

async function readWindowManagementSnapshot(): Promise<WindowManagementSnapshot> {
  const getScreenDetails = window.getScreenDetails;
  if (typeof getScreenDetails === "function") {
    // The call prompts for the window-management permission unless it is
    // already granted; without a recent user gesture the prompt is suppressed,
    // so this can keep failing until the next click.
    const details = await getScreenDetails.call(window);
    const screens: DipScreen[] = details.screens.map((screen) => ({
      left: screen.left,
      top: screen.top,
      width: screen.width,
      height: screen.height,
      devicePixelRatio: screen.devicePixelRatio,
    }));
    const screenIndex = screenIndexForPoint(
      screens,
      window.screenX + window.innerWidth / 2,
      window.screenY + window.innerHeight / 2,
    );
    const screen = screens[screenIndex]!;
    const maximized =
      window.screenY === screen.top &&
      window.outerHeight > 0 &&
      window.outerHeight >= screen.height - 96;
    // Below the window's top edge sit the browser's tab bar and toolbar. For a
    // maximized window that chrome plus the taskbar are already excluded from
    // outerHeight, so the offset is 0; otherwise the outer/inner difference is
    // chrome plus borders, of which roughly the top share precedes the page.
    const chromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
    return {
      status: "ready",
      screens,
      screenIndex,
      viewportLeft: window.screenX,
      viewportTop: maximized ? window.screenY : window.screenY + chromeHeight * 0.8,
    };
  }
  // No Window Management API (or permission denied): window.screen[XY] plus a
  // single screen gives a correct layout for maximized windows on single-DPI
  // setups, and a best effort elsewhere.
  return singleScreenSnapshot();
}

async function refreshWindowManagement() {
  if (typeof window === "undefined" || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const next = await readWindowManagementSnapshot();
    snapshot = next;
    emitSnapshot();
  } catch {
    if (snapshot === null) {
      snapshot = singleScreenSnapshot();
      emitSnapshot();
    }
  } finally {
    refreshInFlight = false;
  }
}

/** Shared window-placement snapshot; refreshed on focus, resize, and clicks. */
export function useWindowManagement(): WindowManagementSnapshot {
  const getSnapshot = () => snapshot ?? INITIAL_SNAPSHOT;
  const value = useSyncExternalStore(subscribeSnapshot, getSnapshot, getSnapshot);
  useEffect(() => {
    void refreshWindowManagement();
  }, []);
  return value;
}

// --- Root sync and backdrop layer -------------------------------------------

/**
 * Keeps `html[data-wallpaper-backdrop]` and the tint variable in step with the
 * client settings, and restores the opaque browser-chrome colors on turn-off.
 */
export function WallpaperBackdropSync() {
  const enabled = useClientSettings((settings) => settings.wallpaperBackdropEnabled);
  const tint = useClientSettings((settings) => settings.wallpaperBackdropTint);

  useEffect(() => {
    const root = document.documentElement;
    if (!enabled) {
      const wasActive = root.hasAttribute("data-wallpaper-backdrop");
      root.removeAttribute("data-wallpaper-backdrop");
      root.style.removeProperty("--wallpaper-backdrop-tint");
      if (wasActive) syncBrowserChromeTheme();
      return;
    }
    root.setAttribute("data-wallpaper-backdrop", "");
    root.style.setProperty("--wallpaper-backdrop-tint", `${tint}%`);
    syncBrowserChromeTheme();
    // Theme changes resync the browser chrome while the attribute is set, and
    // the sync keeps the root transparent for as long as the backdrop is on.
    const onThemeChange = () => syncBrowserChromeTheme();
    window.addEventListener("focus", onThemeChange);
    return () => {
      window.removeEventListener("focus", onThemeChange);
    };
  }, [enabled, tint]);

  return null;
}

export function WallpaperBackdropLayer() {
  const enabled = useClientSettings((settings) => settings.wallpaperBackdropEnabled);
  const [stored] = useLocalStorage(WALLPAPER_STORAGE_KEY, null, StoredWallpaper);
  const management = useWindowManagement();
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const measuredUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (stored === null) {
      setImageSize(null);
      measuredUrlRef.current = null;
      return;
    }
    const image = new Image();
    image.addEventListener("load", () => {
      measuredUrlRef.current = stored.dataUrl;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    });
    image.src = stored.dataUrl;
    return () => {
      image.src = "";
    };
  }, [stored]);

  // While the permission is still pending, any click counts as the activation
  // the screen-details prompt needs, so retry on every gesture until ready.
  const retryWindowManagement = useEffectEvent(() => {
    if (management.status !== "ready") void refreshWindowManagement();
  });
  useEffect(() => {
    if (!enabled || management.status === "ready") return;
    window.addEventListener("pointerdown", retryWindowManagement, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", retryWindowManagement, { capture: true });
    };
  }, [enabled, management.status, retryWindowManagement]);

  if (!enabled || stored === null || imageSize === null) return null;
  const rect = wallpaperViewportRect(management.screens, imageSize, {
    viewportLeft: management.viewportLeft,
    viewportTop: management.viewportTop,
    screenIndex: management.screenIndex,
  });
  if (rect === null) return null;

  return createPortal(
    <div
      aria-hidden="true"
      id="t3code-wallpaper-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        backgroundColor: "var(--background)",
        backgroundImage: `url("${stored.dataUrl}")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: `${rect.x}px ${rect.y}px`,
        backgroundSize: `${rect.width}px ${rect.height}px`,
      }}
    />,
    document.body,
  );
}
