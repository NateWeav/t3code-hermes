// Geometry for painting a spanned desktop wallpaper behind the app so a
// maximized browser window looks transparent. Windows' Span fit covers the
// bounding box of every monitor in physical pixels, while the page only sees
// Chromium's DIP coordinates, which differ on mixed-DPI layouts.

export interface DipScreen {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PhysicalScreen {
  readonly dip: DipScreen;
  readonly physical: Rect;
}

interface Span {
  readonly begin: number;
  readonly length: number;
}

const physicalLength = (dipLength: number, scale: number) => Math.round(dipLength * scale);

// Inverts `CalculateDisplayPlacement` in Chromium's ui/display/win/scaling_util.cc
// along the shared edge, trying its branches in the same order it does.
function physicalBeginAlongEdge(
  parentDip: Span,
  parentPhysical: Span,
  parentScale: number,
  childDip: Span,
  childPhysicalLength: number,
  childScale: number,
): number {
  const dipOffset = childDip.begin - parentDip.begin;
  const parentEnd = parentPhysical.length;
  const endAligned = parentEnd - childPhysicalLength;
  if (dipOffset === parentDip.length - childDip.length && endAligned !== 0) {
    return parentPhysical.begin + endAligned;
  }
  const beginInRange = Math.round(dipOffset * parentScale);
  if (beginInRange >= 0 && beginInRange <= parentEnd) return parentPhysical.begin + beginInRange;
  const offsetFromEnd = parentDip.length - childDip.length - dipOffset;
  const childEnd = parentEnd - Math.round(offsetFromEnd * parentScale);
  if (childEnd >= 0 && childEnd <= parentEnd) {
    return parentPhysical.begin + childEnd - childPhysicalLength;
  }
  return parentPhysical.begin + Math.round(dipOffset * childScale);
}

function placeTouching(parent: PhysicalScreen, child: DipScreen): Rect | null {
  const p = parent.dip;
  const width = physicalLength(child.width, child.devicePixelRatio);
  const height = physicalLength(child.height, child.devicePixelRatio);
  const overlapsVertically = child.top < p.top + p.height && child.top + child.height > p.top;
  const overlapsHorizontally = child.left < p.left + p.width && child.left + child.width > p.left;
  const alongY = () =>
    physicalBeginAlongEdge(
      { begin: p.top, length: p.height },
      { begin: parent.physical.y, length: parent.physical.height },
      p.devicePixelRatio,
      { begin: child.top, length: child.height },
      height,
      child.devicePixelRatio,
    );
  const alongX = () =>
    physicalBeginAlongEdge(
      { begin: p.left, length: p.width },
      { begin: parent.physical.x, length: parent.physical.width },
      p.devicePixelRatio,
      { begin: child.left, length: child.width },
      width,
      child.devicePixelRatio,
    );
  if (overlapsVertically && child.left === p.left + p.width) {
    return { x: parent.physical.x + parent.physical.width, y: alongY(), width, height };
  }
  if (overlapsVertically && child.left + child.width === p.left) {
    return { x: parent.physical.x - width, y: alongY(), width, height };
  }
  if (overlapsHorizontally && child.top === p.top + p.height) {
    return { x: alongX(), y: parent.physical.y + parent.physical.height, width, height };
  }
  if (overlapsHorizontally && child.top + child.height === p.top) {
    return { x: alongX(), y: parent.physical.y - height, width, height };
  }
  return null;
}

/**
 * Recovers Windows' physical monitor rectangles from Chromium's DIP screens by
 * walking outward from the primary display (the one at the origin). Screens
 * that touch nothing fall back to scaling their DIP origin.
 */
export function toPhysicalScreens(screens: readonly DipScreen[]): Rect[] {
  const primary = screens.find((screen) => screen.left === 0 && screen.top === 0) ?? screens[0];
  if (!primary) return [];
  const placed = new Map<DipScreen, PhysicalScreen>();
  placed.set(primary, {
    dip: primary,
    physical: {
      x: 0,
      y: 0,
      width: physicalLength(primary.width, primary.devicePixelRatio),
      height: physicalLength(primary.height, primary.devicePixelRatio),
    },
  });
  const queue = [placed.get(primary)!];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const screen of screens) {
      if (placed.has(screen)) continue;
      const physical = placeTouching(parent, screen);
      if (!physical) continue;
      const entry = { dip: screen, physical };
      placed.set(screen, entry);
      queue.push(entry);
    }
  }
  return screens.map(
    (screen) =>
      placed.get(screen)?.physical ?? {
        x: Math.round(screen.left * screen.devicePixelRatio),
        y: Math.round(screen.top * screen.devicePixelRatio),
        width: physicalLength(screen.width, screen.devicePixelRatio),
        height: physicalLength(screen.height, screen.devicePixelRatio),
      },
  );
}

function boundingBox(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Span fit: scale the image to cover the bounding box and center the overflow. */
export function spanImageRect(
  physicalScreens: readonly Rect[],
  image: { readonly width: number; readonly height: number },
): Rect {
  const box = boundingBox(physicalScreens);
  const scale = Math.max(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export interface ViewportPlacement {
  /** DIP position of the page viewport's top-left corner. */
  readonly viewportLeft: number;
  readonly viewportTop: number;
  /** Index of the screen the viewport is on. */
  readonly screenIndex: number;
}

/**
 * Where the spanned image sits in viewport CSS pixels, so it can be applied as
 * `background-position` / `background-size` on a fixed full-viewport layer.
 */
export function wallpaperViewportRect(
  screens: readonly DipScreen[],
  image: { readonly width: number; readonly height: number },
  placement: ViewportPlacement,
): Rect | null {
  const screen = screens[placement.screenIndex];
  if (!screen || image.width <= 0 || image.height <= 0) return null;
  const physicalScreens = toPhysicalScreens(screens);
  const physicalScreen = physicalScreens[placement.screenIndex]!;
  const imageRect = spanImageRect(physicalScreens, image);
  const scale = screen.devicePixelRatio;
  return {
    x: screen.left + (imageRect.x - physicalScreen.x) / scale - placement.viewportLeft,
    y: screen.top + (imageRect.y - physicalScreen.y) / scale - placement.viewportTop,
    width: imageRect.width / scale,
    height: imageRect.height / scale,
  };
}

/** The screen containing the viewport's center, or the nearest one. */
export function screenIndexForPoint(
  screens: readonly DipScreen[],
  x: number,
  y: number,
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  screens.forEach((screen, index) => {
    const dx = Math.max(screen.left - x, 0, x - (screen.left + screen.width));
    const dy = Math.max(screen.top - y, 0, y - (screen.top + screen.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}
