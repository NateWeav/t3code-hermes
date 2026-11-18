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
import { T, useGT, Var } from "gt-react";
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
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
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

const CLI_PROXY_NAME = "CLI Proxy";

export function UsageProviderSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
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
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const [adding, setAdding] = useState(false);
  const hubsReadOnly = targets.length === 0;

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !hubsReadOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add hub</T>
            </Button>
          ) : null
        }
      >
        {hubs.length === 0 ? (
          <SettingsRow title={gt("No hubs configured.")} />
        ) : (
          hubs.map((hub) => (
            <SettingsRow
              key={hub.url}
              title={hub.label}
              description={
                <span className="break-all">
                  {hub.enabled ? CLI_PROXY_NAME : gt("{name} · Disabled", { name: CLI_PROXY_NAME })}
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
          environmentId={environmentId}
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
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from every environment you manage. Its accounts
              leave the Limits view and limited threads stop getting its reset times; the hub itself
              is untouched. Add it again with the URL and key to bring them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove hub</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
