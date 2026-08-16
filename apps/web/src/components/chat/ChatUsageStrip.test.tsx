import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ChatUsageStrip,
  buildUsageBar,
  deriveChatUsageDisplay,
  type ChatUsageStripData,
} from "./ChatUsageStrip";

describe("buildUsageBar", () => {
  it("uses the selected heavy and light box-drawing glyphs", () => {
    expect(buildUsageBar(32, 15)).toBe("━━━━━──────────");
    expect(buildUsageBar(64, 15)).toBe("━━━━━━━━━━─────");
  });

  it("clamps invalid and overloaded percentages", () => {
    expect(buildUsageBar(-20, 5)).toBe("─────");
    expect(buildUsageBar(150, 5)).toBe("━━━━━");
  });
});

describe("deriveChatUsageDisplay", () => {
  it("uses the selected thread snapshot for context and cumulative chat tokens", () => {
    expect(
      deriveChatUsageDisplay({
        context: {
          usedTokens: 82_000,
          totalProcessedTokens: 184_000,
          maxTokens: 258_000,
          usedPercentage: (82_000 / 258_000) * 100,
        },
        sevenDayTokens: 1_200_000,
        sevenDayCostUsd: 0.84,
        quota: null,
      }),
    ).toMatchObject({
      contextPercent: 32,
      contextTokens: "82K/258K",
      chatTokens: "184K",
      sevenDayTokens: "1.2M",
      cost: "$0.84",
    });
  });

  it("does not preserve values when the newly selected thread has no snapshot", () => {
    expect(
      deriveChatUsageDisplay({
        context: null,
        sevenDayTokens: 1_200_000,
        sevenDayCostUsd: 0.84,
        quota: null,
      }),
    ).toMatchObject({
      contextPercent: null,
      contextTokens: null,
      chatTokens: null,
    });
  });

  it("falls back to the selected thread's used tokens when cumulative processed is absent", () => {
    expect(
      deriveChatUsageDisplay({
        context: {
          usedTokens: 82_000,
          totalProcessedTokens: null,
          maxTokens: 258_000,
          usedPercentage: 32,
        },
        sevenDayTokens: 0,
        sevenDayCostUsd: 0,
        quota: null,
      }).chatTokens,
    ).toBe("82K");
  });

  it("normalizes a real weekly quota into used percentage", () => {
    expect(
      deriveChatUsageDisplay({
        context: null,
        sevenDayTokens: 0,
        sevenDayCostUsd: 0,
        quota: {
          label: "Weekly",
          remainingPercent: 36,
          resetsAt: "2026-08-18T00:00:00.000Z",
        },
      }).quota,
    ).toMatchObject({ label: "Weekly", usedPercent: 64, remainingPercent: 36 });
  });
});

describe("ChatUsageStrip", () => {
  const data: ChatUsageStripData = {
    context: {
      usedTokens: 82_000,
      totalProcessedTokens: 184_000,
      maxTokens: 258_000,
      usedPercentage: (82_000 / 258_000) * 100,
    },
    sevenDayTokens: 1_200_000,
    sevenDayCostUsd: 0.84,
    quota: {
      label: "Weekly",
      remainingPercent: 36,
      resetsAt: "2026-08-18T00:00:00.000Z",
    },
  };

  it("renders the compact context, chat, rolling usage, cost, and weekly quota readout", () => {
    const markup = renderToStaticMarkup(<ChatUsageStrip data={data} />);

    expect(markup).not.toContain('class="hidden min-w-0 cursor-default');
    expect(markup).toContain("Context 32%");
    expect(markup).toContain("━━━━━──────────");
    expect(markup).toContain("82K/258K");
    expect(markup).toContain("Chat 184K");
    expect(markup).toContain("7d 1.2M");
    expect(markup).toContain("$0.84");
    expect(markup).toContain("Weekly 64%");
    expect(markup).toContain("━━━━━━━━━━─────");
  });
});
