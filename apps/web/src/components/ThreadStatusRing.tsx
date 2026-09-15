import { cn } from "~/lib/utils";
import type { ThreadStatusRing as ThreadStatusRingModel } from "./Sidebar.logic";

const MOTION_CLASS: Record<ThreadStatusRingModel["motion"], string> = {
  travel: "animate-thread-ring-travel",
  breathe: "animate-thread-ring-breathe",
  alarm: "animate-thread-ring-alarm",
  none: "",
};

// No viewBox on purpose: SVG user units are then CSS pixels, so the stroke
// width and corner radius stay exact instead of being scaled by the row's
// aspect ratio. The box is inset by half the stroke so the line lands on the
// row's own edge instead of being clipped by its overflow-hidden corners.
const STROKE_WIDTH = 1.5;
// rounded-md (6px) less the inset, so the outline follows the row's corners.
const CORNER_RADIUS = 5.25;
const TRAVEL_DASH_ARRAY = "6 6";

/** The status outline around a sidebar card row: the same state the row's
    label spells out, drawn on its whole perimeter. Renders nothing when the
    row rests, so quiet rows carry no extra DOM. */
export function ThreadStatusRing(props: { readonly ring: ThreadStatusRingModel | null }) {
  if (props.ring === null) return null;

  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-[0.75px]", props.ring.colorClass)}
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
