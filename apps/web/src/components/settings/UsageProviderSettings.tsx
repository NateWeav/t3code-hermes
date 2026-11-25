import {
  AuthProvidersManageScope,
  type EnvironmentId,
  sessionGrantsScope,
  type SettingsSecretValue,
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
import { type ReactNode, useState } from "react";

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
import { sourceIdFromUrl } from "./AddUsageLimitSourceDialog.logic";
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
const HUB_REMOVAL_DESCRIPTION =
  "The hub's management key is deleted from every environment you manage. Its accounts leave the Limits view and limited threads stop getting its reset times; the hub itself is untouched. Add it again with the URL and key to bring them back.";

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
  const [adding, setAdding] = useState<"cliproxy" | "http" | null>(null);
  const hubsReadOnly = targets.length === 0;
  // HTTP quota sources answer for one environment's providers, so they stay per environment.
  const current = targets.find((target) => target.environmentId === environmentId);
  const httpSources = current
    ? Object.entries(current.sources).filter(([, source]) => source.kind === "http")
    : [];
  const addSource = (input: {
    readonly kind: "cliproxy" | "http";
    readonly url: string;
    readonly managementKey: SettingsSecretValue;
    readonly label: string;
  }) => {
    if (input.kind === "cliproxy") {
      void writeHubs(planUsageLimitSourceAdd(targets, input));
      return;
    }
    if (!current) return;
    const label = input.label.trim();
    void writeHubs([
      {
        environmentId,
        patch: {
          usageLimitSources: {
            [sourceIdFromUrl(input.url, current.sources, "http")]: {
              kind: "http",
              url: input.url,
              managementKey: input.managementKey,
              enabled: true,
              ...(label ? { label } : {}),
            },
          },
        },
      },
    ]);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !hubsReadOnly || current ? (
            <div className="flex gap-2">
              {!hubsReadOnly ? (
                <Button size="xs" variant="outline" onClick={() => setAdding("cliproxy")}>
                  <PlusIcon className="size-3" aria-hidden />
                  <T>Add hub</T>
                </Button>
              ) : null}
              {current ? (
                <Button size="xs" variant="outline" onClick={() => setAdding("http")}>
                  <PlusIcon className="size-3" aria-hidden />
                  <T>Add HTTP source</T>
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {hubs.length === 0 && httpSources.length === 0 ? (
          <SettingsRow title={gt("No usage sources configured.")} />
        ) : (
          <>
            {hubs.map((hub) => (
              <SettingsRow
                key={hub.url}
                title={hub.label}
                description={
                  <span className="break-all">
                    {hub.enabled
                      ? CLI_PROXY_NAME
                      : gt("{name} · Disabled", { name: CLI_PROXY_NAME })}
                    {hub.label !== hub.url ? ` · ${hub.url}` : ""}
                    {hub.missingFrom.length > 0
                      ? ` · Not saved on ${hub.missingFrom.map(({ label }) => label).join(", ")}. Add it again with its key.`
                      : ""}
                  </span>
                }
                control={
                  <RemoveUsageProviderButton
                    label={hub.label}
                    description={HUB_REMOVAL_DESCRIPTION}
                    onConfirm={() => void writeHubs(planUsageLimitSourceRemoval(targets, hub.url))}
                  />
                }
              />
            ))}
            {httpSources.map(([id, source]) => {
              const kindLabel = gt("HTTP quota source");
              const label = source.label?.trim() || source.url;
              return (
                <SettingsRow
                  key={id}
                  title={label}
                  description={
                    <span className="break-all">
                      {source.enabled ? kindLabel : gt("{name} · Disabled", { name: kindLabel })}
                      {label !== source.url ? ` · ${source.url}` : ""}
                    </span>
                  }
                  control={
                    <RemoveUsageProviderButton
                      label={label}
                      description={
                        <T>
                          The saved connection and its credentials are removed from this
                          environment.
                        </T>
                      }
                      onConfirm={() =>
                        void writeHubs([
                          { environmentId, patch: { usageLimitSources: { [id]: null } } },
                        ])
                      }
                    />
                  }
                />
              );
            })}
          </>
        )}
      </SettingsSection>
      {adding !== null && (adding === "cliproxy" ? !hubsReadOnly : current !== undefined) ? (
        <AddUsageLimitSourceDialog
          open
          kind={adding}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          environmentId={environmentId}
          environmentLabel={current?.label ?? environmentId}
          onAdd={addSource}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  description,
  onConfirm,
}: {
  readonly label: string;
  readonly description: ReactNode;
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
            <AlertDialogDescription>{description}</AlertDialogDescription>
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
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
