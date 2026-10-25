import { cn } from "~/lib/utils";
import type { ThreadStatusRing as ThreadStatusRingModel } from "./Sidebar.logic";

const MOTION_CLASS: Record<ThreadStatusRingModel["motion"], string> = {
  travel: "animate-thread-ring-travel",
  breathe: "animate-thread-ring-breathe",
  alarm: "animate-thread-ring-alarm",
  none: "",
};

// No viewBox, so user units are CSS pixels. The SVG is 1px smaller than the
// row and the half-pixel rect overflows it, so the 1px stroke covers whole
// pixels on every edge without the row's rounded clip thinning the corners.
const STROKE_WIDTH = 1;
// rounded-md less half the stroke, so the outer edge meets the row's corners.
const CORNER_RADIUS = 5.5;
const TRAVEL_DASH_ARRAY = "6 6";

/** The status outline around a sidebar card row: the same state the row's
    label spells out, drawn on its whole perimeter. Renders nothing when the
    row rests, so quiet rows carry no extra DOM. */
export function ThreadStatusRing(props: { readonly ring: ThreadStatusRingModel | null }) {
  if (props.ring === null) return null;

  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", props.ring.colorClass)}
      data-testid={`thread-status-ring-${props.ring.kind}`}
    >
      <svg className="h-[calc(100%-1px)] w-[calc(100%-1px)] overflow-visible" fill="none">
        <rect
          x="0.5"
          y="0.5"
          width="100%"
          height="100%"
          rx={CORNER_RADIUS}
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          // Decoration for a label that already says the same thing, so
          // reduced motion keeps the outline and its hue and only stills it.
          className={cn(MOTION_CLASS[props.ring.motion], "motion-reduce:animate-none")}
          {...(props.ring.dashed ? { strokeDasharray: TRAVEL_DASH_ARRAY } : {})}
        />
      </svg>
    </span>
  );
}
