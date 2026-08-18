import type { ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { ThreadStatusRing } from "./ThreadStatusRing";

// The component holds no state or hooks, so calling it directly is enough to
// assert what it puts on the page.
function renderRing(ring: Parameters<typeof ThreadStatusRing>[0]["ring"]) {
  return ThreadStatusRing({ ring }) as ReactElement<{
    className?: string;
    children: ReactElement<{ children: ReactElement<{ className?: string }> }>;
  }> | null;
}

function rect(ring: NonNullable<Parameters<typeof ThreadStatusRing>[0]["ring"]>) {
  return renderRing(ring)?.props.children.props.children;
}

describe("ThreadStatusRing", () => {
  it("draws nothing for a resting row", () => {
    expect(renderRing(null)).toBeNull();
  });

  it("keeps the outline out of the row's hit target", () => {
    const outline = renderRing({
      kind: "working",
      colorClass: "text-sky-500 dark:text-sky-400",
      dashed: true,
      motion: "travel",
    });

    expect(outline?.props.className).toContain("pointer-events-none");
    expect(outline?.props.className).toContain("absolute");
    expect(outline?.props.className).toContain("text-sky-500 dark:text-sky-400");
  });

  it("animates the stroke, and lets reduced motion still it", () => {
    const stroke = rect({
      kind: "working",
      colorClass: "text-sky-500",
      dashed: true,
      motion: "travel",
    });

    expect(stroke?.props.className).toContain("animate-thread-ring-travel");
    expect(stroke?.props.className).toContain("motion-reduce:animate-none");
  });

  it("dashes the stroke only for the states that travel", () => {
    const dashed = rect({
      kind: "working",
      colorClass: "text-sky-500",
      dashed: true,
      motion: "travel",
    });
    const solid = rect({
      kind: "failed",
      colorClass: "text-red-500",
      dashed: false,
      motion: "alarm",
    });

    expect(dashed?.props).toHaveProperty("strokeDasharray");
    expect(solid?.props).not.toHaveProperty("strokeDasharray");
  });
});
