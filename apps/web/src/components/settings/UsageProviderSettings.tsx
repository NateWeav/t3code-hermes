import {
  AuthProvidersManageScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import {
  listUsageLimitSources,
  planUsageLimitSourceAdd,
  planUsageLimitSourceRemoval,
  type UsageLimitSourceTarget,
  type UsageLimitSourceWrite,
} from "@t3tools/client-runtime/state/usage-limit-sources";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { environmentSessionStatesAtom } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Connected environments whose hubs this connection may change. */
function useUsageLimitSourceTargets(): ReadonlyArray<UsageLimitSourceTarget<EnvironmentId>> {
  const { environments } = useEnvironments();
  const candidates = environments.filter(
    (environment) =>
      supportsSharedSettingsSync(environment) &&
      environment.serverConfig?.environment.capabilities.usageLimitSources === true,
  );
  const sessions = useAtomValue(
    environmentSessionStatesAtom(environmentIdsKey(candidates.map((entry) => entry.environmentId))),
  );
  return candidates.flatMap((environment, index) => {
    const result = sessions[index];
    const session =
      result === undefined || result._tag === "Failure"
        ? null
        : AsyncResult.getOrElse(result, () => null);
    return session !== null && sessionGrantsScope(session, AuthProvidersManageScope)
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            sources: environment.serverConfig?.settings.usageLimitSources ?? {},
          },
        ]
      : [];
  });
}

export function UsageProviderSettings({
  environmentId,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const targets = useUsageLimitSourceTargets();
  const hubs = listUsageLimitSources(targets);
  const persistHubs = useAtomCommand(serverEnvironment.updateSettings, {
    label: "hub settings update",
    reportFailure: false,
  });
  const writeHubs = async (writes: ReadonlyArray<UsageLimitSourceWrite<EnvironmentId>>) => {
    const outcomes = await Promise.all(
      writes.map(async ({ environmentId: target, patch }) => ({
        label: targets.find((entry) => entry.environmentId === target)?.label ?? target,
        result: await persistHubs({ environmentId: target, input: { patch } }),
      })),
    );
    const failed = outcomes.filter(
      ({ result }) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
    );
    if (failed.length === 0) return;
    toastManager.add({
      type: "error",
      title: failed.length === outcomes.length ? "Hub not saved" : "Hub saved on some environments",
      description: `Could not save on ${failed.map(({ label }) => label).join(", ")}. Try again once they reconnect.`,
    });
  };
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const hubsReadOnly = targets.length === 0;

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !hubsReadOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {hubs.length === 0 ? (
          <SettingsRow title="No hubs configured." />
        ) : (
          hubs.map((hub) => (
            <SettingsRow
              key={hub.url}
              title={hub.label}
              description={
                <span className="break-all">
                  CLI Proxy{hub.enabled ? "" : " · Disabled"}
                  {hub.label !== hub.url ? ` · ${hub.url}` : ""}
                  {hub.missingFrom.length > 0
                    ? ` · Not saved on ${hub.missingFrom.map(({ label }) => label).join(", ")}. Add it again with its key.`
                    : ""}
                </span>
              }
              control={
                <RemoveUsageProviderButton
                  label={hub.label}
                  onConfirm={() => void writeHubs(planUsageLimitSourceRemoval(targets, hub.url))}
                />
              }
            />
          ))
        )}
      </SettingsSection>
      {adding && !hubsReadOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          onAdd={(input) => void writeHubs(planUsageLimitSourceAdd(targets, input))}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from every environment you manage. Its accounts
              leave the Limits view and limited threads stop getting its reset times; the hub itself
              is untouched. Add it again with the URL and key to bring them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
