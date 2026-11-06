import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import {
  listUsageLimitSources,
  planUsageLimitSourceAdd,
  planUsageLimitSourceRemoval,
  type UsageLimitSourceWrite,
} from "@t3tools/client-runtime/state/usage-limit-sources";
import { useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/** A hub is saved on every connected environment you manage, so threads anywhere get its resets. */
export function EnvironmentHubSettings() {
  const { environments } = useEnvironments();
  const candidates = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.usageLimitSources === true,
  );
  const manageable = useEnvironmentsWithScope(candidates, AuthProvidersManageScope);
  const targets = candidates.flatMap((environment) =>
    manageable.has(environment.environmentId)
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            sources: environment.serverConfig?.settings.usageLimitSources ?? {},
          },
        ]
      : [],
  );
  const unreachable = environments.filter(
    (environment) => !targets.some((target) => target.environmentId === environment.environmentId),
  );
  const hubs = listUsageLimitSources(targets);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setAdding(false);
    setUrl("");
    setManagementKey("");
    setLabel("");
    setError(null);
  };
  const save = async (writes: ReadonlyArray<UsageLimitSourceWrite<EnvironmentId>>) => {
    if (writes.length === 0 || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(
        writes.map(async ({ environmentId, patch }) => ({
          environmentId,
          result: await updateSettings({ environmentId, input: { patch } }),
        })),
      );
      const failed = results.flatMap(({ environmentId, result }) =>
        result._tag === "Success"
          ? []
          : [targets.find((target) => target.environmentId === environmentId)?.label ?? ""],
      );
      if (failed.length === 0) reset();
      else
        setError(
          `Could not save hub settings on ${failed.join(", ")}. Check the connection and permissions, then try again.`,
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const add = () => {
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("Invalid protocol");
    } catch {
      setError("Enter a valid HTTP or HTTPS hub URL.");
      return;
    }
    if (!managementKey.trim()) return;
    void save(planUsageLimitSourceAdd(targets, { url, managementKey, label }));
  };
  return (
    <SettingsSection title="CLIProxyAPI hubs">
      <View className="gap-3 p-4">
        {hubs.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No hubs configured.</Text>
        ) : (
          hubs.map((hub) => (
            <View key={hub.url} className="gap-1">
              <Text className="text-base text-foreground">{hub.label}</Text>
              <Text className="text-sm text-foreground-muted">
                {hub.url}
                {hub.enabled ? "" : " · Disabled"}
              </Text>
              {hub.missingFrom.length > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Not saved on {hub.missingFrom.map((target) => target.label).join(", ")}. Add it
                  again with its key.
                </Text>
              ) : null}
              <HubButton
                label="Remove hub"
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    `Remove ${hub.label}?`,
                    "Its accounts will leave Limits and its management key will be deleted from every environment you manage. You can add it again with its URL and key.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove hub",
                        style: "destructive",
                        onPress: () => void save(planUsageLimitSourceRemoval(targets, hub.url)),
                      },
                    ],
                  )
                }
              />
            </View>
          ))
        )}
        {targets.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            Connect an environment you manage to add a hub.
          </Text>
        ) : adding ? (
          <View className="gap-3">
            <Text className="text-sm text-foreground-muted">
              Show limits across the hub's accounts and resume limited threads when they come back.
              Use a URL every environment can reach. The management key stays on their servers.
            </Text>
            <TextInput
              accessibilityLabel="Hub URL"
              placeholder="https://hub.example.com:8318"
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!busy}
              className="min-h-11 rounded-xl bg-subtle px-3 py-2 text-base"
            />
            <TextInput
              accessibilityLabel="Management key"
              placeholder="Management key"
              value={managementKey}
              onChangeText={setManagementKey}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              editable={!busy}
              className="min-h-11 rounded-xl bg-subtle px-3 py-2 text-base"
            />
            <TextInput
              accessibilityLabel="Label (optional)"
              placeholder="Label (optional)"
              value={label}
              onChangeText={setLabel}
              editable={!busy}
              className="min-h-11 rounded-xl bg-subtle px-3 py-2 text-base"
            />
            <View className="flex-row gap-3">
              <HubButton label="Cancel" disabled={busy} onPress={reset} />
              <HubButton
                label={busy ? "Saving…" : "Add hub"}
                disabled={busy || !url.trim() || !managementKey.trim()}
                onPress={add}
              />
            </View>
          </View>
        ) : (
          <HubButton label="Add hub" disabled={busy} onPress={() => setAdding(true)} />
        )}
        {unreachable.length > 0 && targets.length > 0 ? (
          <Text className="text-sm text-foreground-muted">
            Not saved on {unreachable.map((environment) => environment.label).join(", ")} until they
            are connected, up to date, and managed from this device.
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-red-500">
            {error}
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function HubButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center self-start rounded-full bg-subtle-strong px-4 py-2 disabled:opacity-50"
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
