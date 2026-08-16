import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface ChatUsageContextData {
  readonly usedTokens: number;
  readonly totalProcessedTokens: number | null;
  readonly maxTokens: number | null;
  readonly usedPercentage: number | null;
}

export interface ChatUsageQuotaData {
  readonly label: string;
  /** Sanitized upstream provider identity; no credential or auth metadata. */
  readonly provider?: string;
  readonly remainingPercent: number;
  readonly resetsAt: string | null;
}

export interface ChatUsageStripData {
  readonly context: ChatUsageContextData | null;
  readonly sevenDayTokens: number;
  readonly sevenDayCostUsd: number;
  readonly quota: ChatUsageQuotaData | null;
  readonly isHistoricalUsagePending?: boolean;
  readonly isHistoricalUsagePartial?: boolean;
}

interface ChatUsageDisplay {
  readonly contextPercent: number | null;
  readonly contextTokens: string | null;
  readonly chatTokens: string | null;
  readonly sevenDayTokens: string;
  readonly cost: string;
  readonly quota: {
    readonly label: string;
    readonly usedPercent: number;
    readonly remainingPercent: number;
    readonly resetsAt: string | null;
  } | null;
}

const BAR_WIDTH = 15;

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function buildUsageBar(percentage: number, width = BAR_WIDTH): string {
  const safeWidth = Math.max(1, Math.round(width));
  const filled = Math.round((clampPercentage(percentage) / 100) * safeWidth);
  return `${"━".repeat(filled)}${"─".repeat(safeWidth - filled)}`;
}

function roundedPercentage(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(clampPercentage(value));
}

function formatCompactTokens(value: number): string {
  const formatted = formatTokens(value);
  return formatted.replace(/(\.\d*[1-9])0+(?=[A-Z]$)/, "$1").replace(/\.0+(?=[A-Z]$)/, "");
}

function formatReset(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function deriveChatUsageDisplay(data: ChatUsageStripData): ChatUsageDisplay {
  const contextPercent = roundedPercentage(data.context?.usedPercentage ?? null);
  const contextTokens = data.context
    ? data.context.maxTokens !== null
      ? `${formatCompactTokens(data.context.usedTokens)}/${formatCompactTokens(data.context.maxTokens)}`
      : formatCompactTokens(data.context.usedTokens)
    : null;
  const reportedTotalProcessedTokens = data.context?.totalProcessedTokens ?? null;
  const totalProcessedTokens =
    reportedTotalProcessedTokens !== null && reportedTotalProcessedTokens > 0
      ? reportedTotalProcessedTokens
      : (data.context?.usedTokens ?? null);
  const remainingPercent = data.quota ? roundedPercentage(data.quota.remainingPercent) : null;

  return {
    contextPercent,
    contextTokens,
    chatTokens:
      totalProcessedTokens !== null && totalProcessedTokens >= 0
        ? formatCompactTokens(totalProcessedTokens)
        : null,
    sevenDayTokens: formatCompactTokens(data.sevenDayTokens),
    cost: formatUsd(data.sevenDayCostUsd),
    quota:
      data.quota && remainingPercent !== null
        ? {
            label: data.quota.label,
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            resetsAt: data.quota.resetsAt,
          }
        : null,
  };
}

function UsageBar(props: { readonly percentage: number; readonly label: string }) {
  return (
    <span
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.percentage}
      className="font-mono text-[10px] tracking-[-0.08em] text-muted-foreground"
    >
      {buildUsageBar(props.percentage)}
    </span>
  );
}

export function ChatUsageStrip({ data }: { readonly data: ChatUsageStripData }) {
  const display = deriveChatUsageDisplay(data);
  const historicalStatus = data.isHistoricalUsagePending
    ? "Loading seven-day usage"
    : data.isHistoricalUsagePartial
      ? "Seven-day usage is still reporting from some environments"
      : "Seven-day usage across connected environments";
  const reset = formatReset(display.quota?.resetsAt ?? null);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            aria-label="Chat usage details"
            className={cn(
              "flex min-w-0 cursor-default items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        {display.contextPercent !== null ? (
          <span className="hidden shrink-0 items-center gap-1.5 tabular-nums @4xl/header-actions:flex">
            <span>Context {display.contextPercent}%</span>
            <UsageBar percentage={display.contextPercent} label="Context window usage" />
            {display.contextTokens ? <span>{display.contextTokens}</span> : null}
          </span>
        ) : display.contextTokens ? (
          <span className="hidden shrink-0 tabular-nums @4xl/header-actions:inline">
            Context {display.contextTokens}
          </span>
        ) : null}

        {display.chatTokens ? (
          <span className="shrink-0 tabular-nums">Chat {display.chatTokens}</span>
        ) : (
          <span className="shrink-0 text-secondary-label">Chat —</span>
        )}

        <span aria-hidden className="text-border">
          ·
        </span>
        <span className="hidden shrink-0 tabular-nums @3xl/header-actions:inline">
          7d {data.isHistoricalUsagePending ? "—" : display.sevenDayTokens}
        </span>
        <span className="hidden shrink-0 tabular-nums @5xl/header-actions:inline">
          {data.isHistoricalUsagePending ? "—" : display.cost}
        </span>

        {display.quota ? (
          <>
            <span aria-hidden className="hidden text-border @5xl/header-actions:inline">
              ·
            </span>
            <span className="hidden shrink-0 items-center gap-1.5 tabular-nums @5xl/header-actions:flex">
              <span>
                {display.quota.label} {display.quota.usedPercent}%
              </span>
              <UsageBar
                percentage={display.quota.usedPercent}
                label={`${display.quota.label} quota used`}
              />
              {reset ? <span>resets {reset}</span> : null}
            </span>
          </>
        ) : null}
      </PopoverTrigger>

      <PopoverPopup
        tooltipStyle
        side="bottom"
        align="center"
        viewportClassName="p-0"
        className="w-72 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)] text-[11px]">
          <div className="font-medium text-xs text-muted-foreground">Usage</div>
          <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <span className="text-secondary-label">Current context</span>
            <span>{display.contextTokens ?? "Not reported"}</span>
            <span className="text-secondary-label">Current chat processed</span>
            <span>{display.chatTokens ?? "Not reported"}</span>
            <span className="text-secondary-label">Rolling seven days</span>
            <span>{data.isHistoricalUsagePending ? "Loading" : display.sevenDayTokens}</span>
            <span className="text-secondary-label">Seven-day API equivalent</span>
            <span>{data.isHistoricalUsagePending ? "Loading" : display.cost}</span>
            {display.quota ? (
              <>
                <span className="text-secondary-label">{display.quota.label} remaining</span>
                <span>{display.quota.remainingPercent}%</span>
                <span className="text-secondary-label">Resets</span>
                <span>{reset ?? "Not reported"}</span>
                {data.quota?.provider ? (
                  <>
                    <span className="text-secondary-label">Quota source</span>
                    <span>{data.quota.provider}</span>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="text-secondary-label">{historicalStatus}</div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
