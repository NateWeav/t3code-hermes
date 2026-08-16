import { useNavigation } from "@react-navigation/native";
import {
  quotaEnvironmentLabel,
  type PresentedQuotaAccount,
} from "@t3tools/client-runtime/state/provider-quota";
import type { ProviderQuotaAccount } from "@t3tools/contracts";
import type { DailyTotals, MergedUsage } from "@t3tools/shared/usageMerge";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useProviderQuota } from "../../state/providerQuota";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import type { UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const CHART_HEIGHT = 180;

export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);
  const quota = useProviderQuota();

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const chartDays = useMemo(
    () =>
      isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
        ? enumerateHourStarts(window.sinceTime, window.untilTime)
        : days,
    [days, isPast24Hours, window.sinceTime, window.untilTime],
  );
  const chartTotals = useMemo(
    (): readonly DailyTotals[] =>
      isPast24Hours
        ? merged.hourly.map((hour) => ({
            day: hour.hourStart,
            costUsd: hour.costUsd,
            totalTokens: hour.totalTokens,
            byProvider: hour.byProvider,
          }))
        : merged.daily,
    [isPast24Hours, merged.daily, merged.hourly],
  );

  // The pull spinner tracks re-scans of environments that have answered
  // before. The initial scan renders its own placeholder, and an unreachable
  // environment stays pending forever — neither may pin the spinner on.
  const refreshing =
    quota.environments.some((entry) => entry.isPending && entry.accounts.length > 0) ||
    environments.some((entry) => entry.isPending && entry.summary !== null);
  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Usage" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              quota.refresh();
              refreshWindow();
            }}
          />
        }
      >
        <MobileQuotaLimits
          accounts={quota.accounts}
          environmentCount={quota.environments.length}
          error={quota.error}
          isPending={quota.isPending}
        />

        <View className="gap-1 border-t border-border pt-6">
          <Text className="text-xl font-t3-semibold text-foreground">Activity</Text>
          <Text className="text-sm text-foreground-muted">
            Token volume and API-equivalent cost from local provider history.
          </Text>
        </View>

        <SegmentedControl
          options={WINDOW_OPTIONS.map((option) => ({
            value: option.days,
            label: option.label,
          }))}
          selected={windowDays}
          onSelect={selectWindow}
        />

        <UsageCoverageNotice environments={environments} merged={merged} isPartial={isPartial} />

        {isPending ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Scanning provider transcripts…
          </Text>
        ) : environments.length === 0 ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Connect an environment to see usage.
          </Text>
        ) : (
          <>
            <ChartCard
              merged={merged}
              days={chartDays}
              daily={chartTotals}
              metric={metric}
              onMetricChange={setMetric}
              sinceDay={window.sinceDay}
              untilDay={window.untilDay}
              isPast24Hours={isPast24Hours}
              timeZone={window.timeZone}
            />
            <ProviderSection merged={merged} metric={metric} />
            <TotalsSection merged={merged} isPast24Hours={isPast24Hours} />
            <ModelsSection merged={merged} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

function mobileQuotaProvider(account: ProviderQuotaAccount): "codex" | "claude" | "opencode" {
  return account.provider === "claudeAgent"
    ? "claude"
    : account.provider === "opencode"
      ? "opencode"
      : "codex";
}

function mobileFormatReset(resetsAt: string | null): string {
  if (resetsAt === null) return "Reset unavailable";
  const reset = new Date(resetsAt);
  const minutes = Math.ceil((reset.valueOf() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes)) return "Reset unavailable";
  if (minutes <= 0) return "Resetting now";
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets ${reset.toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function MobileQuotaLimits(props: {
  readonly accounts: readonly PresentedQuotaAccount[];
  readonly environmentCount: number;
  readonly error: string | null;
  readonly isPending: boolean;
}) {
  if (props.isPending) {
    return (
      <Text className="py-16 text-center text-base text-foreground-muted">
        Reading plan limits…
      </Text>
    );
  }
  if (props.accounts.length === 0) {
    return (
      <Text className="py-16 text-center text-base text-foreground-muted">
        {props.error ?? "Sign in to Codex, Claude, or OpenCode to see plan limits."}
      </Text>
    );
  }
  return (
    <View className="gap-4">
      <View className="gap-1">
        <Text className="text-xl font-t3-semibold text-foreground">Subscription runway</Text>
        <Text className="text-sm text-foreground-muted">
          Plan capacity from provider accounts and local history, separate from token activity and
          cost.
        </Text>
      </View>
      {props.accounts.map((account) => (
        <MobileQuotaCard
          key={account.key}
          account={account}
          showEnvironment={props.environmentCount > 1}
        />
      ))}
    </View>
  );
}

function MobileQuotaCard(props: {
  readonly account: PresentedQuotaAccount;
  readonly showEnvironment: boolean;
}) {
  const colors = useProviderColors();
  const provider = mobileQuotaProvider(props.account);
  const [firstWindow, ...otherWindows] = props.account.windows;
  if (firstWindow === undefined) return null;
  const strongest = otherWindows.reduce(
    (current, window) => (window.usedPercent > current.usedPercent ? window : current),
    firstWindow,
  );
  return (
    <View className="gap-5 rounded-[24px] border-continuous bg-card p-5">
      <View className="flex-row items-center gap-3">
        <View className="size-3 rounded-full" style={{ backgroundColor: colors[provider] }} />
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {props.account.displayName}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {[
              props.account.accountLabel,
              props.account.planLabel,
              props.showEnvironment ? quotaEnvironmentLabel(props.account) : null,
            ]
              .filter(Boolean)
              .join(" · ") || PROVIDER_LABEL[provider]}
          </Text>
        </View>
      </View>
      <View className="gap-0.5">
        <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
          {Math.round(100 - strongest.usedPercent)}% left
        </Text>
        <Text className="text-sm text-foreground-muted">Most constrained: {strongest.label}</Text>
      </View>
      <View className="gap-4">
        {props.account.windows.map((window) => (
          <View key={window.id} className="gap-2">
            <View className="flex-row justify-between gap-3">
              <Text className="text-sm text-foreground">{window.label}</Text>
              <Text className="text-sm tabular-nums text-foreground-muted">
                {Math.round(window.usedPercent)}% · {mobileFormatReset(window.resetsAt)}
              </Text>
            </View>
            <View className="h-2 overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{
                  width: `${window.usedPercent}%`,
                  backgroundColor: window.usedPercent >= 85 ? "#f59e0b" : colors[provider],
                }}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function SegmentedControl<Value extends number | string>(props: {
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
}) {
  return (
    <View className="flex-row overflow-hidden rounded-full border-continuous bg-card">
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(option.value)}
            className={
              active
                ? "flex-1 items-center rounded-full bg-subtle-strong py-2"
                : "flex-1 items-center py-2"
            }
          >
            <Text
              className={
                active ? "text-sm font-t3-medium text-foreground" : "text-sm text-foreground-muted"
              }
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Headline figure, the animated daily chart, and its legend, in one card. */
function ChartCard(props: {
  readonly merged: MergedUsage;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (metric: UsageChartMetric) => void;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly isPast24Hours: boolean;
  readonly timeZone: string;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  const hasActivity = props.daily.some((period) => period.totalTokens > 0);

  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm text-foreground-muted">
            {metric === "cost" ? "Raw token cost" : "Processed tokens"}
          </Text>
          <Text className="text-4xl font-t3-bold tabular-nums text-foreground">
            {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {metric === "cost"
              ? "* if billed at full API rate"
              : `Across ${formatCount(merged.sessions)} sessions`}
          </Text>
        </View>
        <MetricToggle metric={metric} onChange={props.onMetricChange} />
      </View>

      {hasActivity ? (
        <UsageDailyChart
          days={props.days}
          daily={props.daily}
          metric={metric}
          height={CHART_HEIGHT}
        />
      ) : (
        <View style={{ height: CHART_HEIGHT }} className="items-center justify-center">
          <Text className="text-base text-foreground-muted">No activity in this window.</Text>
        </View>
      )}

      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-foreground-tertiary">
          {props.isPast24Hours
            ? formatHourShort(props.days[0] ?? "", props.timeZone)
            : formatDayShort(props.sinceDay)}
        </Text>
        <View className="flex-row items-center gap-4">
          {merged.providers.map((provider) => (
            <View key={provider.provider} className="flex-row items-center gap-1.5">
              <View
                className="size-2 rounded-full"
                style={{ backgroundColor: colors[provider.provider] }}
              />
              <Text className="text-xs text-foreground-muted">
                {PROVIDER_LABEL[provider.provider]}
              </Text>
            </View>
          ))}
        </View>
        <Text className="text-xs text-foreground-tertiary">
          {props.isPast24Hours
            ? formatHourShort(props.days[props.days.length - 1] ?? "", props.timeZone)
            : formatDayShort(props.untilDay)}
        </Text>
      </View>
    </View>
  );
}

function MetricToggle(props: {
  readonly metric: UsageChartMetric;
  readonly onChange: (metric: UsageChartMetric) => void;
}) {
  return (
    <View className="flex-row overflow-hidden rounded-full bg-subtle">
      {(["cost", "tokens"] as const).map((option) => {
        const active = option === props.metric;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => props.onChange(option)}
            className={active ? "rounded-full bg-subtle-strong px-3 py-1.5" : "px-3 py-1.5"}
          >
            <Text
              className={
                active
                  ? "text-xs font-t3-medium uppercase text-foreground"
                  : "text-xs uppercase text-foreground-muted"
              }
            >
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ProviderSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.providers.length === 0) return null;

  // Ranked by whatever the toggle is showing, so the rows always descend.
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
  const ordered = [...merged.providers].sort((a, b) =>
    metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
  );

  return (
    <SettingsSection title="Providers" card>
      {ordered.map((provider, index) => {
        const share = metric === "cost" ? provider.costShare : provider.tokenShare;
        return (
          <View
            key={provider.provider}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text className="text-lg text-foreground">{PROVIDER_LABEL[provider.provider]}</Text>
              </View>
              <Text className="text-lg tabular-nums text-foreground">
                {metric === "cost"
                  ? formatUsd(provider.costUsd)
                  : formatTokens(provider.totalTokens)}
              </Text>
            </View>
            <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full rounded-full"
                style={{ flex: share, backgroundColor: colors[provider.provider] }}
              />
              <View style={{ flex: 1 - share }} />
            </View>
            <Text className="text-sm text-foreground-muted">
              {metric === "cost"
                ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: { readonly merged: MergedUsage; readonly isPast24Hours: boolean }) {
  const { merged } = props;
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title="Totals" card>
      <View className="flex-row flex-wrap">
        <MetricCell
          label="Processed tokens"
          value={formatTokens(merged.totalTokens)}
          detail={`${formatTokens(periodAverage)} per active ${props.isPast24Hours ? "hour" : "day"}`}
        />
        <MetricCell
          label="Cache savings"
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw cost`
              : "vs full input rates"
          }
        />
        <MetricCell
          label="Cached input"
          value={formatTokens(merged.cachedInputTokens)}
          detail={`${formatPercent(cachedShare)} of observed input`}
        />
        <MetricCell
          label="Uncached input"
          value={formatTokens(merged.uncachedInputTokens)}
          detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
        />
        <MetricCell
          label="Output"
          value={formatTokens(merged.outputTokens)}
          detail={`incl. ${formatTokens(merged.reasoningTokens)} reasoning`}
        />
        <MetricCell
          label="Unpriced"
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail="of records, excluded from cost"
        />
      </View>
    </SettingsSection>
  );
}

function MetricCell(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <View className="w-1/2 gap-0.5 p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-xl font-t3-medium tabular-nums text-foreground">{props.value}</Text>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: { readonly merged: MergedUsage }) {
  const { merged } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  return (
    <SettingsSection title="By model" card>
      {merged.models.map((model, index) => (
        <View
          key={`${model.provider}:${model.model}`}
          className={
            index === 0
              ? "flex-row items-center gap-3 p-4"
              : "flex-row items-center gap-3 border-t border-border-subtle p-4"
          }
        >
          <View
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colors[model.provider] }}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base text-foreground" numberOfLines={1}>
              {model.model}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {formatPercent(model.costShare)} of cost · {formatTokens(model.totalTokens)} tokens
            </Text>
          </View>
          <Text className="text-base tabular-nums text-foreground">{formatUsd(model.costUsd)}</Text>
        </View>
      ))}
    </SettingsSection>
  );
}

/**
 * Says plainly when the totals are incomplete: an environment still answering,
 * one that failed, or one whose transcripts another environment already
 * reported.
 */
function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const failed = props.environments.filter((environment) => environment.error !== null);
  const stale = props.environments.filter((environment) =>
    props.merged.staleEnvironments.includes(environment.environmentId),
  );
  const duplicateSources = props.merged.duplicateSources;
  if (
    failed.length === 0 &&
    stale.length === 0 &&
    duplicateSources.length === 0 &&
    !props.isPartial
  ) {
    return null;
  }

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {props.isPartial ? (
        <Text className="text-sm text-foreground-muted">
          Some environments are still reporting. Totals are partial.
        </Text>
      ) : null}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} could not report usage.
        </Text>
      ))}
      {stale.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} runs an older server version and is excluded from totals.
        </Text>
      ))}
      {duplicateSources.length > 0 ? (
        <Text className="text-sm text-foreground-muted">
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}
