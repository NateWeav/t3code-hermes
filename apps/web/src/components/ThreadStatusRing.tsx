import { cn } from "~/lib/utils";
import type { ThreadStatusRing as ThreadStatusRingModel } from "./Sidebar.logic";

const MOTION_CLASS: Record<ThreadStatusRingModel["motion"], string> = {
  travel: "animate-thread-ring-travel",
  breathe: "animate-thread-ring-breathe",
  alarm: "animate-thread-ring-alarm",
  none: "",
};

// No viewBox, so user units are CSS pixels. The rect sits on the row's edge
// and the SVG clips the stroke's outer half, leaving a 1px line inside; a
// fractional inset snaps the origin but not the far edges, blurring them.
const STROKE_WIDTH = 2;
// rounded-md, so the stroke's centre line follows the row's clipped corners.
const CORNER_RADIUS = 6;
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
      <svg className="h-full w-full" fill="none">
        <rect
          x="0"
          y="0"
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
