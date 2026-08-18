import { useNavigation } from "@react-navigation/native";
import {
  describeHermesJobStatus,
  describeHermesJobSummary,
  formatHermesRunDuration,
  formatHermesTimestamp,
  HERMES_NEW_TASK_TEMPLATE,
  type HermesCronStatusTone,
} from "@t3tools/client-runtime/state/hermes-cron";
import {
  describeHindsightEmptyList,
  describeHindsightRetainResult,
  describeHindsightStats,
  describeHindsightUnavailable,
  formatHindsightMemoryAge,
  HINDSIGHT_PATHWAY_FILTERS,
  HINDSIGHT_PATHWAY_LABELS,
  HINDSIGHT_STATS_PENDING_LABEL,
} from "@t3tools/client-runtime/state/hindsight";
import type {
  EnvironmentId,
  HermesCronJob,
  HermesCronJobId,
  HermesCronRun,
  HindsightBankId,
  HindsightBankStats,
  HindsightMemory,
} from "@t3tools/contracts";
import { HINDSIGHT_MAX_NOTE_LENGTH } from "@t3tools/contracts";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import {
  IconBell,
  IconBellOff,
  IconChevronRight,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconX,
} from "@tabler/icons-react-native";
import { useCallback, useMemo, useState } from "react";
import { Alert, Platform, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs } from "../../state/entities";
import { useHermesCron } from "../../state/hermesCron";
import { useHindsightMemory } from "../../state/hindsight";

const HERMES_DRIVER = "hermes";
type HermesTab = "tasks" | "memory";

interface HermesEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function useHermesEnvironmentOptions(): ReadonlyArray<HermesEnvironmentOption> {
  const configs = useServerConfigs();
  return useMemo(() => {
    const options: HermesEnvironmentOption[] = [];
    for (const [environmentId, config] of configs) {
      if (config.providers.some((provider) => provider.driver === HERMES_DRIVER)) {
        options.push({ environmentId, label: config.environment.label });
      }
    }
    return options.sort((left, right) => left.label.localeCompare(right.label));
  }, [configs]);
}

export function useHermesProviderPresent(): boolean {
  return useHermesEnvironmentOptions().length > 0;
}

export function HermesRouteScreen() {
  const navigation = useNavigation();
  const environments = useHermesEnvironmentOptions();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [tab, setTab] = useState<HermesTab>("tasks");
  const environmentId =
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
      ? selectedEnvironmentId
      : (environments[0]?.environmentId ?? null);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Hermes" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      {environmentId === null ? (
        <CenteredState
          title="Hermes is not available"
          description="Connect an environment with a Hermes provider instance to use Tasks and Memory."
        />
      ) : (
        <View className="flex-1">
          <HermesHeader
            environments={environments}
            selectedEnvironmentId={environmentId}
            onSelectEnvironment={setSelectedEnvironmentId}
            tab={tab}
            onSelectTab={setTab}
          />
          <View className="flex-1" key={`${environmentId}:${tab}`}>
            {tab === "tasks" ? (
              <HermesTasksScreen environmentId={environmentId} />
            ) : (
              <HermesMemoryScreen environmentId={environmentId} />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function HermesHeader(props: {
  readonly environments: ReadonlyArray<HermesEnvironmentOption>;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly onSelectEnvironment: (environmentId: EnvironmentId) => void;
  readonly tab: HermesTab;
  readonly onSelectTab: (tab: HermesTab) => void;
}) {
  return (
    <View className="gap-3 border-b border-border px-5 pb-3 pt-3">
      <View className="flex-row items-center gap-3">
        <View className="size-11 items-center justify-center rounded-full bg-subtle">
          <ProviderIcon provider="hermes" size={24} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-t3-semibold text-foreground">Hermes</Text>
          <Text className="text-sm text-foreground-muted">Scheduled work and Hindsight memory</Text>
        </View>
      </View>

      {props.environments.length > 1 ? (
        <View className="flex-row flex-wrap gap-2" accessibilityRole="radiogroup">
          {props.environments.map((environment) => (
            <ChipButton
              key={environment.environmentId}
              label={environment.label}
              selected={environment.environmentId === props.selectedEnvironmentId}
              onPress={() => props.onSelectEnvironment(environment.environmentId)}
            />
          ))}
        </View>
      ) : null}

      <View className="flex-row rounded-full bg-subtle p-1">
        {(["tasks", "memory"] as const).map((item) => {
          const selected = props.tab === item;
          return (
            <Pressable
              key={item}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => props.onSelectTab(item)}
              className={
                selected
                  ? "h-11 flex-1 items-center justify-center rounded-full bg-card"
                  : "h-11 flex-1 items-center justify-center rounded-full"
              }
            >
              <Text
                className={
                  selected
                    ? "text-sm font-t3-semibold text-foreground"
                    : "text-sm text-foreground-muted"
                }
              >
                {item === "tasks" ? "Tasks" : "Memory"}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function HermesTasksScreen({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const cron = useHermesCron(environmentId);
  const [expandedJobIds, setExpandedJobIds] = useState<ReadonlySet<HermesCronJobId>>(
    () => new Set(),
  );

  const toggleExpanded = useCallback((jobId: HermesCronJobId) => {
    setExpandedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }, []);

  const runMutation = useCallback(async (label: string, mutation: () => Promise<boolean>) => {
    if (await mutation()) return;
    Alert.alert(`${label} failed`, "The environment did not accept that change. Try again.");
  }, []);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<HermesCronJob>) => (
      <TaskRow
        job={item}
        expanded={expandedJobIds.has(item.id)}
        pending={cron.pendingJobIds.has(item.id)}
        onToggleExpanded={() => toggleExpanded(item.id)}
        onSetEnabled={(enabled) =>
          runMutation(enabled ? "Resume" : "Pause", () => cron.setEnabled(item.id, enabled))
        }
        onSetMuted={(muted) =>
          runMutation(muted ? "Mute" : "Unmute", () => cron.setMuted(item.id, muted))
        }
      />
    ),
    [
      cron.pendingJobIds,
      cron.setEnabled,
      cron.setMuted,
      expandedJobIds,
      runMutation,
      toggleExpanded,
    ],
  );

  const empty =
    cron.error !== null ? (
      <CenteredState
        title="Hermes tasks are unavailable"
        description={cron.error}
        actionLabel="Try again"
        onAction={cron.refresh}
      />
    ) : cron.isPending ? (
      <CenteredState title="Loading tasks" description="Reading Hermes's scheduled work…" />
    ) : cron.emptyState !== null ? (
      <CenteredState title={cron.emptyState.title} description={cron.emptyState.description} />
    ) : null;

  return (
    <LegendList
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        paddingHorizontal: 16,
        paddingTop: 12,
      }}
      data={cron.jobs}
      estimatedItemSize={124}
      keyExtractor={(job) => job.id}
      ListEmptyComponent={empty}
      ListHeaderComponent={
        cron.view.snapshot?.runHistoryAvailable === false ? (
          <NoticeText text="Run history is unavailable, so only the latest outcome is shown." />
        ) : null
      }
      ListFooterComponent={
        <View className="mt-2 gap-2 border-t border-border py-4">
          <ActionButton
            label="New task…"
            icon={<IconPlus size={18} color={String(iconColor)} />}
            onPress={() => {
              copyTextWithHaptic(HERMES_NEW_TASK_TEMPLATE, { target: "new task template" });
              Alert.alert(
                "Template copied",
                "Open a Hermes chat and paste it into the composer to describe the schedule you want.",
              );
            }}
          />
          <Text className="px-1 text-sm text-foreground-muted">
            Tasks are written by Hermes itself — describe the schedule you want in chat.
          </Text>
        </View>
      }
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

function TaskRow(props: {
  readonly job: HermesCronJob;
  readonly expanded: boolean;
  readonly pending: boolean;
  readonly onToggleExpanded: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onSetMuted: (muted: boolean) => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-icon-muted");
  const status = describeHermesJobStatus(props.job);
  return (
    <View className="mb-3 overflow-hidden rounded-[20px] border border-border bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onToggleExpanded}
        className="min-h-16 flex-row items-center gap-3 px-4 py-3"
      >
        <IconChevronRight
          color={String(mutedColor)}
          size={18}
          style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-semibold text-foreground" numberOfLines={1}>
            {props.job.name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {describeHermesJobSummary(props.job)}
          </Text>
        </View>
        <StatusChip tone={status.tone} label={status.label} />
      </Pressable>

      <View className="flex-row border-t border-border-subtle px-2 py-1">
        <CompactAction
          disabled={props.pending}
          label={props.job.enabled ? "Pause" : "Resume"}
          icon={
            props.job.enabled ? (
              <IconPlayerPause size={18} color={String(iconColor)} />
            ) : (
              <IconPlayerPlay size={18} color={String(iconColor)} />
            )
          }
          onPress={() => props.onSetEnabled(!props.job.enabled)}
        />
        <CompactAction
          disabled={props.pending}
          label={props.job.muted ? "Unmute" : "Mute"}
          icon={
            props.job.muted ? (
              <IconBellOff size={18} color={String(iconColor)} />
            ) : (
              <IconBell size={18} color={String(iconColor)} />
            )
          }
          onPress={() => props.onSetMuted(!props.job.muted)}
        />
      </View>

      {props.expanded ? (
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          {props.job.deliver.length > 0 ? (
            <Text className="text-sm text-foreground-muted">
              Delivers to {props.job.deliver.join(", ")}
            </Text>
          ) : null}
          {props.job.lastError === null ? null : (
            <Text className="font-mono text-xs text-destructive">{props.job.lastError}</Text>
          )}
          {props.job.runs.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No recorded runs yet.</Text>
          ) : (
            props.job.runs.map((run) => <RunRow key={run.id} run={run} />)
          )}
        </View>
      ) : null}
    </View>
  );
}

function RunRow({ run }: { readonly run: HermesCronRun }) {
  const when = formatHermesTimestamp(run.finishedAt ?? run.startedAt ?? run.claimedAt);
  const duration = formatHermesRunDuration(run.durationMs);
  return (
    <View className="gap-1 border-t border-border-subtle pt-2">
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Text
          className={
            run.status === "failed"
              ? "text-sm font-t3-semibold text-destructive"
              : "text-sm font-t3-semibold text-foreground-muted"
          }
        >
          {run.status}
        </Text>
        {when === null ? null : <Text className="text-xs text-foreground-muted">{when}</Text>}
        {duration === null ? null : (
          <Text className="text-xs text-foreground-muted">· {duration}</Text>
        )}
      </View>
      {run.error === null ? null : (
        <Text className="font-mono text-xs text-destructive" numberOfLines={4}>
          {run.error}
        </Text>
      )}
    </View>
  );
}

function StatusChip(props: { readonly tone: HermesCronStatusTone; readonly label: string }) {
  const className: Record<HermesCronStatusTone, string> = {
    ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    failed: "bg-destructive/10 text-destructive",
    paused: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    idle: "bg-subtle text-foreground-muted",
  };
  return (
    <View className={`rounded-full px-2.5 py-1 ${className[props.tone]}`}>
      <Text className={`text-xs font-t3-semibold ${className[props.tone]}`}>{props.label}</Text>
    </View>
  );
}

function HermesMemoryScreen({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  const memory = useHindsightMemory(environmentId);
  const [draft, setDraft] = useState("");
  const [retainOpen, setRetainOpen] = useState(false);
  const [retainText, setRetainText] = useState("");
  const unavailable = describeHindsightUnavailable(memory.status);

  const submitRecall = useCallback(() => memory.submitQuery(draft), [draft, memory]);
  const clearRecall = useCallback(() => {
    setDraft("");
    memory.clearQuery();
  }, [memory]);
  const retain = useCallback(async () => {
    const result = await memory.retain(retainText);
    if (result === null) {
      Alert.alert("Note not saved", "Hindsight did not accept the note.");
      return;
    }
    Alert.alert("Note saved", describeHindsightRetainResult(result.itemsCount));
    setRetainText("");
    setRetainOpen(false);
  }, [memory, retainText]);
  const reflect = useCallback(async () => {
    const result = await memory.reflect();
    if (result === null) {
      Alert.alert("Reflection failed", "Hindsight could not complete the reflection.");
      return;
    }
    Alert.alert("Reflection ready", "The result is shown above the memory list.");
  }, [memory]);

  if (unavailable !== null) {
    return (
      <CenteredState
        title={unavailable.title}
        description={unavailable.description}
        actionLabel={unavailable.retryable ? "Try again" : undefined}
        onAction={unavailable.retryable ? memory.retry : undefined}
      />
    );
  }
  if (memory.error !== null) {
    return (
      <CenteredState
        title="Memory is unavailable"
        description={memory.error}
        actionLabel="Try again"
        onAction={memory.retry}
      />
    );
  }

  const emptyState = describeHindsightEmptyList(memory.submittedQuery);
  return (
    <LegendList
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        paddingHorizontal: 16,
        paddingTop: 12,
      }}
      data={memory.memories}
      estimatedItemSize={130}
      keyExtractor={(item) => `${item.pathway}:${item.id}`}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <MemoryHeader
          banks={memory.banks}
          bank={memory.bank}
          onSelectBank={memory.selectBank}
          pathway={memory.pathway}
          onSelectPathway={memory.selectPathway}
          draft={draft}
          submittedQuery={memory.submittedQuery}
          onChangeDraft={setDraft}
          onSubmit={submitRecall}
          onClear={clearRecall}
          reflection={memory.reflection}
          onDismissReflection={memory.dismissReflection}
          stats={memory.stats}
          isStatsPending={memory.isStatsPending}
        />
      }
      ListEmptyComponent={
        memory.isPending ? (
          <CenteredState
            title="Loading memory"
            description="Reading the selected Hindsight bank…"
          />
        ) : (
          <CenteredState title={emptyState.title} description={emptyState.description} />
        )
      }
      ListFooterComponent={
        <MemoryFooter
          bankAvailable={memory.bank !== null}
          hasMore={memory.hasMore}
          memoryCount={memory.memories.length}
          retainOpen={retainOpen}
          retainText={retainText}
          isRetaining={memory.isRetaining}
          isReflecting={memory.isReflecting}
          onChangeRetainText={setRetainText}
          onOpenRetain={() => setRetainOpen(true)}
          onCancelRetain={() => {
            setRetainText("");
            setRetainOpen(false);
          }}
          onRetain={() => void retain()}
          onReflect={() => void reflect()}
        />
      }
      renderItem={({ item }: LegendListRenderItemProps<HindsightMemory>) => (
        <MemoryRow memory={item} />
      )}
      showsVerticalScrollIndicator={false}
    />
  );
}

function MemoryHeader(props: {
  readonly banks: ReadonlyArray<{ readonly id: HindsightBankId; readonly name: string | null }>;
  readonly bank: HindsightBankId | null;
  readonly onSelectBank: (bank: HindsightBankId) => void;
  readonly pathway: (typeof HINDSIGHT_PATHWAY_FILTERS)[number]["value"];
  readonly onSelectPathway: (pathway: (typeof HINDSIGHT_PATHWAY_FILTERS)[number]["value"]) => void;
  readonly draft: string;
  readonly submittedQuery: string;
  readonly onChangeDraft: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClear: () => void;
  readonly reflection: string | null;
  readonly onDismissReflection: () => void;
  readonly stats: HindsightBankStats | null;
  readonly isStatsPending: boolean;
}) {
  const iconColor = useThemeColor("--color-icon");
  const placeholderColor = useThemeColor("--color-foreground-muted");
  return (
    <View className="mb-3 gap-3">
      <MemoryStatsStrip isPending={props.isStatsPending} stats={props.stats} />

      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel="Search memories"
          className="h-11 min-w-0 flex-1 rounded-[16px] border border-border bg-card px-4 text-base text-foreground"
          onChangeText={props.onChangeDraft}
          onSubmitEditing={props.onSubmit}
          placeholder="Recall something…"
          placeholderTextColor={String(placeholderColor)}
          returnKeyType="search"
          value={props.draft}
        />
        <Pressable
          accessibilityLabel="Recall memories"
          accessibilityRole="button"
          onPress={props.onSubmit}
          className="size-11 items-center justify-center rounded-full bg-primary"
        >
          <IconSearch size={19} color="white" />
        </Pressable>
        {props.submittedQuery.length > 0 ? (
          <Pressable
            accessibilityLabel="Clear search"
            accessibilityRole="button"
            onPress={props.onClear}
            className="size-11 items-center justify-center rounded-full bg-subtle"
          >
            <IconX size={19} color={String(iconColor)} />
          </Pressable>
        ) : null}
      </View>

      <View className="flex-row flex-wrap gap-2">
        {HINDSIGHT_PATHWAY_FILTERS.map((filter) => (
          <ChipButton
            key={filter.value}
            label={filter.label}
            selected={props.pathway === filter.value}
            onPress={() => props.onSelectPathway(filter.value)}
          />
        ))}
      </View>

      {props.banks.length > 1 ? (
        <View className="gap-2">
          <Text className="text-xs font-t3-semibold uppercase tracking-wide text-foreground-muted">
            Memory bank
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {props.banks.map((bank) => (
              <ChipButton
                key={bank.id}
                label={bank.name ?? bank.id}
                selected={bank.id === props.bank}
                onPress={() => props.onSelectBank(bank.id)}
              />
            ))}
          </View>
        </View>
      ) : null}

      {props.reflection === null ? null : (
        <View className="flex-row items-start gap-2 rounded-[18px] border border-border bg-subtle p-4">
          <Text className="min-w-0 flex-1 text-sm leading-5 text-foreground">
            {props.reflection}
          </Text>
          <Pressable
            accessibilityLabel="Dismiss reflection"
            accessibilityRole="button"
            onPress={props.onDismissReflection}
            className="size-11 items-center justify-center rounded-full"
          >
            <IconX size={18} color={String(iconColor)} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * How big the bank is, in one line above the search box.
 *
 * Same words as the web panel, and the same honesty: nothing at all when the
 * counts could not be read (the memories underneath are still fine), and a
 * neutral line rather than zeroes until they land.
 */
function MemoryStatsStrip(props: {
  readonly isPending: boolean;
  readonly stats: HindsightBankStats | null;
}) {
  if (props.stats === null) {
    return props.isPending ? (
      <Text className="text-xs text-foreground-muted">{HINDSIGHT_STATS_PENDING_LABEL}</Text>
    ) : null;
  }

  const summary = describeHindsightStats(props.stats);
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-semibold text-foreground">{summary.counts.join(" · ")}</Text>
      {summary.breakdown.length === 0 ? null : (
        <Text className="text-xs text-foreground-muted">{summary.breakdown.join(" · ")}</Text>
      )}
      {summary.operations.length === 0 ? null : (
        <Text className="text-xs text-amber-700 dark:text-amber-300">
          {summary.operations.join(" · ")}
        </Text>
      )}
    </View>
  );
}

function MemoryRow({ memory }: { readonly memory: HindsightMemory }) {
  const when = formatHindsightMemoryAge(memory.rememberedAt);
  return (
    <View className="mb-3 gap-2 rounded-[20px] border border-border bg-card p-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <View className="rounded-full bg-subtle px-2.5 py-1">
          <Text className="text-xs font-t3-semibold text-foreground-muted">
            {HINDSIGHT_PATHWAY_LABELS[memory.pathway]}
          </Text>
        </View>
        {when === null ? null : <Text className="text-xs text-foreground-muted">{when}</Text>}
        {memory.confidence === null ? null : (
          <Text className="text-xs text-foreground-muted">
            {Math.round(memory.confidence * 100)}% match
          </Text>
        )}
      </View>
      {memory.title === null ? null : (
        <Text className="text-base font-t3-semibold text-foreground">{memory.title}</Text>
      )}
      <Text className="text-base leading-6 text-foreground" selectable>
        {memory.text}
      </Text>
      {memory.context === null || memory.context.length === 0 ? null : (
        <Text className="text-sm text-foreground-muted">{memory.context}</Text>
      )}
      {memory.entities.length === 0 ? null : (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {memory.entities.join(" · ")}
        </Text>
      )}
    </View>
  );
}

function MemoryFooter(props: {
  readonly bankAvailable: boolean;
  readonly hasMore: boolean;
  readonly memoryCount: number;
  readonly retainOpen: boolean;
  readonly retainText: string;
  readonly isRetaining: boolean;
  readonly isReflecting: boolean;
  readonly onChangeRetainText: (value: string) => void;
  readonly onOpenRetain: () => void;
  readonly onCancelRetain: () => void;
  readonly onRetain: () => void;
  readonly onReflect: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const placeholderColor = useThemeColor("--color-foreground-muted");
  return (
    <View className="gap-3 border-t border-border py-4">
      {props.hasMore ? (
        <NoticeText
          text={`Showing the most recent ${props.memoryCount}. Narrow it with a search or a filter.`}
        />
      ) : null}
      {props.retainOpen ? (
        <View className="gap-2 rounded-[20px] border border-border bg-card p-3">
          <TextInput
            accessibilityLabel="Note to remember"
            className="min-h-24 rounded-[16px] bg-subtle px-4 py-3 text-base text-foreground"
            maxLength={HINDSIGHT_MAX_NOTE_LENGTH}
            multiline
            onChangeText={props.onChangeRetainText}
            placeholder="Something worth remembering…"
            placeholderTextColor={String(placeholderColor)}
            textAlignVertical="top"
            value={props.retainText}
          />
          <View className="flex-row gap-2">
            <ActionButton
              disabled={props.isRetaining || props.retainText.trim().length === 0}
              label={props.isRetaining ? "Saving…" : "Save note"}
              onPress={props.onRetain}
            />
            <ActionButton label="Cancel" onPress={props.onCancelRetain} />
          </View>
        </View>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          <ActionButton
            disabled={!props.bankAvailable}
            label="Retain a note…"
            icon={<IconPlus size={18} color={String(iconColor)} />}
            onPress={props.onOpenRetain}
          />
          <ActionButton
            disabled={!props.bankAvailable || props.isReflecting}
            label={props.isReflecting ? "Reflecting…" : "Reflect now"}
            icon={<IconSparkles size={18} color={String(iconColor)} />}
            onPress={props.onReflect}
          />
        </View>
      )}
    </View>
  );
}

function ChipButton(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={
        props.selected
          ? "min-h-11 justify-center rounded-full bg-subtle-strong px-4"
          : "min-h-11 justify-center rounded-full bg-subtle px-4"
      }
    >
      <Text
        className={
          props.selected
            ? "text-sm font-t3-semibold text-foreground"
            : "text-sm text-foreground-muted"
        }
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "min-h-11 flex-row items-center justify-center gap-2 rounded-full bg-subtle px-4 opacity-50"
          : "min-h-11 flex-row items-center justify-center gap-2 rounded-full bg-subtle px-4"
      }
    >
      {props.icon}
      <Text className="text-sm font-t3-semibold text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function CompactAction(props: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "h-11 flex-1 flex-row items-center justify-center gap-2 rounded-full opacity-50"
          : "h-11 flex-1 flex-row items-center justify-center gap-2 rounded-full"
      }
    >
      {props.icon}
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function NoticeText({ text }: { readonly text: string }) {
  return (
    <Text className="mb-3 rounded-[16px] bg-subtle px-4 py-3 text-sm text-foreground-muted">
      {text}
    </Text>
  );
}

function CenteredState(props: {
  readonly title: string;
  readonly description: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8 py-16">
      <Text className="text-center text-lg font-t3-semibold text-foreground">{props.title}</Text>
      <Text className="text-center text-sm leading-5 text-foreground-muted">
        {props.description}
      </Text>
      {props.actionLabel && props.onAction ? (
        <ActionButton
          label={props.actionLabel}
          icon={<IconRefresh size={18} color={String(iconColor)} />}
          onPress={props.onAction}
        />
      ) : null}
    </View>
  );
}
