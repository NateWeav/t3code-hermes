import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, HermesIcon, type Icon, OpenAI, OpenCodeIcon } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart, table, legend, and skeleton, so
 * adding a provider only requires its contract support and one entry here.
 */
export const PROVIDER_PRESENTATION = {
  opencode: {
    label: "OpenCode",
    color: "#7c3aed",
    mark: OpenCodeIcon,
  },
  hermes: {
    label: "Hermes",
    color: "#38bdf8",
    mark: HermesIcon,
  },
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];
