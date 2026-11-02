/**
 * Settings → Hermes. Patches lead because T3 Code features depend on them: the fork's changes to
 * Hermes itself, and where each stands in the scoped environment's checkout, or in every one at
 * once. Decisions live in `state/hermesPatches`.
 */
import {
  describeHermesGateway,
  describeHermesPatchesUnavailable,
  describeHermesPatchHint,
  describeHermesPatchNeed,
  HERMES_PATCH_STATE_LABELS,
  HERMES_UPDATE_DESCRIPTION,
  HERMES_UPDATE_LABEL,
  HERMES_UPDATE_PENDING_LABEL,
  shouldOfferHermesUpdate,
} from "@t3tools/client-runtime/state/hermes-patches";
import type {
  EnvironmentId,
  HermesPatch,
  HermesPatchId,
  HermesPatchState,
} from "@t3tools/contracts";
import { InfoIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useHermesEnvironmentIds } from "../../state/hermesCron";
import {
  hermesPatchTargets,
  type HermesPatchesOnDevice,
  isHermesPatchWorkBusy,
  useHermesPatches,
  useHermesPatchesEverywhere,
} from "../../state/hermesPatches";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { HermesHubsSettingsSection } from "./HermesHubsSettings";
import { HermesRunsSettingsSection } from "./HermesRunsSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { selectEnvironmentAxis, settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

const STATE_BADGE: Record<HermesPatchState, "success" | "info" | "warning"> = {
  applied: "success",
  notApplied: "info",
  doesNotApply: "warning",
};

export function HermesSettingsPanel() {
  return (
    <SettingsPageContainer>
      <HermesPatchesSection />
      <HermesRunsSettingsSection />
      <HermesHubsSettingsSection />
    </SettingsPageContainer>
  );
}

function HermesPatchesSection() {
  const { scope, search, environments, connectedEnvironments, selectScope } = useSettingsScope();
  const hermesEnvironmentIds = useHermesEnvironmentIds();
  const hermesEnvironments = connectedEnvironments.filter((environment) =>
    hermesEnvironmentIds.includes(environment.environmentId),
  );
  // A single chosen environment shows its checkout even without Hermes, so the server says why.
  const environmentId =
    scope.environmentIds.length === 1
      ? scope.environmentIds[0]!
      : hermesEnvironments.length === 1
        ? hermesEnvironments[0]!.environmentId
        : null;

  if (environmentId !== null) return <HermesPatchesOnEnvironment environmentId={environmentId} />;
  if (hermesEnvironments.length === 0) {
    return (
      <SettingsSection id="hermes-patches" title="Patches">
        <SettingsRow
          title="No Hermes environment"
          description="Connect an environment with the Hermes provider enabled to manage its patches."
        />
      </SettingsSection>
    );
  }
  return (
    <HermesPatchesEverywhere
      environments={hermesEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        label: settingsScopeEnvironmentLabel(environment, environments),
      }))}
      onShowEnvironment={(next) => selectScope(selectEnvironmentAxis(search, next))}
    />
  );
}

function PatchesHeaderActions({
  applyAll,
  onCheckAgain,
  checkAgainDisabled = false,
}: {
  /** Null while nothing has been read yet. */
  readonly applyAll: {
    readonly running: boolean;
    readonly disabled: boolean;
    readonly onClick: () => void;
  } | null;
  readonly onCheckAgain: () => void;
  readonly checkAgainDisabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {applyAll === null ? null : (
        <Button size="xs" disabled={applyAll.disabled} onClick={applyAll.onClick}>
          {applyAll.running ? "Applying…" : "Apply all"}
        </Button>
      )}
      <Button size="xs" variant="ghost-muted" disabled={checkAgainDisabled} onClick={onCheckAgain}>
        <RefreshCwIcon className="size-3" />
        Check again
      </Button>
    </div>
  );
}

function PendingRow() {
  return (
    <div className="space-y-1.5 px-3 py-3 sm:px-4" aria-hidden>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-3.5 w-72" />
    </div>
  );
}

function NoticeTitle({
  tone,
  children,
}: {
  readonly tone: "info" | "warning";
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {tone === "info" ? (
        <InfoIcon aria-hidden className="size-3.5 shrink-0 text-info" />
      ) : (
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
      )}
      {children}
    </span>
  );
}

function PatchTitle({
  title,
  state,
}: {
  readonly title: string;
  readonly state: HermesPatchState | undefined;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {title}
      {state === undefined ? null : (
        <Badge variant={STATE_BADGE[state]} size="sm">
          {HERMES_PATCH_STATE_LABELS[state]}
        </Badge>
      )}
    </span>
  );
}

function PatchRow({
  patch,
  busy,
  disabled,
  updating,
  canUpdateHermes,
  onApply,
  onRemove,
  onUpdateHermes,
}: {
  readonly patch: HermesPatch;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly updating: boolean;
  readonly canUpdateHermes: boolean;
  readonly onApply: () => void;
  readonly onRemove: () => void;
  readonly onUpdateHermes: () => void;
}) {
  return (
    <SettingsRow
      title={<PatchTitle title={patch.title} state={patch.state} />}
      description={describeHermesPatchNeed(patch)}
      status={describeHermesPatchHint(patch)}
      control={
        patch.state === "notApplied" ? (
          <Button size="sm" disabled={disabled} onClick={onApply}>
            {busy ? "Applying…" : "Apply"}
          </Button>
        ) : patch.state === "applied" ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={onRemove}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        ) : patch.reason === "hermesTooOld" && canUpdateHermes ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={onUpdateHermes}>
            {updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
          </Button>
        ) : null
      }
    />
  );
}

function HermesPatchesOnEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const {
    snapshot,
    isPending,
    error,
    changingPatchId,
    updating,
    updateSummary,
    busy,
    refresh,
    updateHermes,
    apply,
    remove,
    applyingAll,
    applyAll,
    requestingRestart,
    restartGateway,
  } = useHermesPatches(environmentId);

  const ready = snapshot !== null && describeHermesPatchesUnavailable(snapshot) === null;
  const header = isPending ? null : (
    <PatchesHeaderActions
      applyAll={
        ready
          ? {
              running: applyingAll,
              disabled: busy || !snapshot.patches.some((patch) => patch.state === "notApplied"),
              onClick: applyAll,
            }
          : null
      }
      onCheckAgain={refresh}
      checkAgainDisabled={updating}
    />
  );
  if (isPending || snapshot === null) {
    return (
      <SettingsSection id="hermes-patches" title="Patches" headerAction={header}>
        {isPending ? (
          <PendingRow />
        ) : (
          <SettingsRow
            title="Patches are unavailable"
            description={error ?? "The environment did not answer."}
          />
        )}
      </SettingsSection>
    );
  }

  const unavailable = describeHermesPatchesUnavailable(snapshot);
  if (unavailable !== null) {
    return (
      <SettingsSection id="hermes-patches" title="Patches" headerAction={header}>
        <SettingsRow title={unavailable.title} description={unavailable.description} />
      </SettingsSection>
    );
  }

  const gateway = describeHermesGateway(snapshot.gateway, snapshot.gatewayRestartFailure);

  return (
    <SettingsSection id="hermes-patches" title="Patches" headerAction={header}>
      <SettingsRow
        title="Hermes checkout"
        description={<span className="font-mono break-all">{snapshot.checkoutPath}</span>}
      />
      {shouldOfferHermesUpdate(snapshot) || updating ? (
        <SettingsRow
          title={<NoticeTitle tone="info">Hermes update</NoticeTitle>}
          description={HERMES_UPDATE_DESCRIPTION}
          control={
            <Button size="sm" disabled={busy} onClick={updateHermes}>
              {updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
            </Button>
          }
        />
      ) : null}
      {updateSummary === null ? null : (
        <SettingsRow role="status" title="Last update" description={updateSummary} />
      )}
      {gateway === null ? null : (
        <SettingsRow
          title={<NoticeTitle tone={gateway.tone}>Hermes gateway</NoticeTitle>}
          description={gateway.text}
          control={
            gateway.restart ? (
              <Button
                size="sm"
                variant="outline"
                disabled={requestingRestart || busy}
                onClick={restartGateway}
              >
                <RotateCwIcon />
                {requestingRestart ? "Restarting…" : "Restart gateway"}
              </Button>
            ) : null
          }
        />
      )}
      {snapshot.patches.length === 0 ? (
        <SettingsRow
          title="No patches"
          description="This T3 Code release carries no Hermes patches."
        />
      ) : (
        snapshot.patches.map((patch) => (
          <PatchRow
            key={patch.id}
            patch={patch}
            busy={changingPatchId === patch.id}
            disabled={busy}
            updating={updating}
            canUpdateHermes={snapshot.canUpdateHermes === true}
            onApply={() => apply(patch.id)}
            onRemove={() => remove(patch.id)}
            onUpdateHermes={updateHermes}
          />
        ))
      )}
    </SettingsSection>
  );
}

interface EnvironmentNote {
  readonly environmentId: EnvironmentId;
  readonly kind: string;
  readonly tone: "info" | "warning";
  readonly text: string;
  readonly action: ReactNode;
}

/**
 * The patches on every Hermes environment at once. Each patch is one row; Apply and Remove act on
 * every environment where they fit. What only one environment needs (an update, a gateway
 * restart, a checkout that cannot be read) is a row naming it.
 */
function HermesPatchesEverywhere({
  environments,
  onShowEnvironment,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onShowEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "an environment";
  const { devices, refresh, apply, remove, applyAll, updateHermes, restartGateway } =
    useHermesPatchesEverywhere(
      environments.map((environment) => environment.environmentId),
      labelOf,
    );

  if (devices.every((device) => device.isPending)) {
    return (
      <SettingsSection id="hermes-patches" title="Patches">
        <PendingRow />
      </SettingsSection>
    );
  }

  const showButton = (environmentId: EnvironmentId) => (
    <Button size="sm" variant="outline" onClick={() => onShowEnvironment(environmentId)}>
      Show environment
    </Button>
  );
  const notes = devices.flatMap((device): EnvironmentNote[] => {
    const { environmentId, snapshot, work } = device;
    if (snapshot === null) {
      return device.error === null
        ? []
        : [
            {
              environmentId,
              kind: "error",
              tone: "warning",
              text: `Patches could not be read. ${device.error}`,
              action: showButton(environmentId),
            },
          ];
    }
    const unavailable = describeHermesPatchesUnavailable(snapshot);
    if (unavailable !== null) {
      return [
        {
          environmentId,
          kind: "unavailable",
          tone: "info",
          text: `${unavailable.title}. ${unavailable.description}`,
          action: showButton(environmentId),
        },
      ];
    }
    const result: EnvironmentNote[] = [];
    if (shouldOfferHermesUpdate(snapshot) || work.updating) {
      result.push({
        environmentId,
        kind: "update",
        tone: "info",
        text: HERMES_UPDATE_DESCRIPTION,
        action: (
          <Button
            size="sm"
            disabled={isHermesPatchWorkBusy(work)}
            onClick={() => updateHermes(environmentId)}
          >
            {work.updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
          </Button>
        ),
      });
    }
    if (work.updateSummary !== null) {
      result.push({
        environmentId,
        kind: "summary",
        tone: "info",
        text: work.updateSummary,
        action: null,
      });
    }
    const gateway = describeHermesGateway(snapshot.gateway, snapshot.gatewayRestartFailure);
    if (gateway !== null) {
      result.push({
        environmentId,
        kind: "gateway",
        tone: gateway.tone,
        text: gateway.text,
        action: gateway.restart ? (
          <Button
            size="sm"
            variant="outline"
            disabled={work.requestingRestart || isHermesPatchWorkBusy(work)}
            onClick={() => restartGateway(environmentId)}
          >
            <RotateCwIcon />
            {work.requestingRestart ? "Restarting…" : "Restart gateway"}
          </Button>
        ) : null,
      });
    }
    return result;
  });

  // Environments may run different T3 Code releases, so the rows are every patch any of them carries.
  const patches = new Map<HermesPatchId, HermesPatch>();
  for (const device of devices) {
    if (device.snapshot?.availability !== "ready") continue;
    for (const patch of device.snapshot.patches) {
      if (!patches.has(patch.id)) patches.set(patch.id, patch);
    }
  }

  return (
    <SettingsSection
      id="hermes-patches"
      title="Patches"
      headerAction={
        <PatchesHeaderActions
          applyAll={{
            running: devices.some((device) => device.work.applyingAll),
            disabled:
              devices.some((device) => isHermesPatchWorkBusy(device.work)) ||
              !devices.some(
                (device) =>
                  device.snapshot?.availability === "ready" &&
                  device.snapshot.patches.some((patch) => patch.state === "notApplied"),
              ),
            onClick: applyAll,
          }}
          onCheckAgain={refresh}
        />
      }
    >
      <SettingsRow
        title="Every Hermes environment"
        description="Apply and Remove act on each environment where the patch fits. Choose one environment above to see its checkout."
      />
      {notes.map((note) => (
        <SettingsRow
          key={`${note.environmentId}:${note.kind}`}
          {...(note.kind === "summary" ? { role: "status" } : {})}
          title={<NoticeTitle tone={note.tone}>{labelOf(note.environmentId)}</NoticeTitle>}
          description={note.text}
          control={note.action}
        />
      ))}
      {patches.size === 0 ? (
        <SettingsRow
          title="No patches"
          description="No environment has a Hermes checkout with patches to show."
        />
      ) : (
        [...patches.values()].map((patch) => (
          <EverywherePatchRow
            key={patch.id}
            patch={patch}
            devices={devices}
            labelOf={labelOf}
            onApply={() => apply(patch.id)}
            onRemove={() => remove(patch.id)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function EverywherePatchRow({
  patch,
  devices,
  labelOf,
  onApply,
  onRemove,
}: {
  readonly patch: HermesPatch;
  readonly devices: ReadonlyArray<HermesPatchesOnDevice>;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly onApply: () => void;
  readonly onRemove: () => void;
}) {
  const states = devices.flatMap((device) => {
    const onDevice =
      device.snapshot?.availability === "ready"
        ? device.snapshot.patches.find((candidate) => candidate.id === patch.id)
        : undefined;
    return onDevice === undefined ? [] : [{ device, patch: onDevice }];
  });
  const toApply = hermesPatchTargets(devices, patch.id, "notApplied");
  const toRemove = hermesPatchTargets(devices, patch.id, "applied");
  // Apply first, so a patch only some environments have converges to everywhere.
  const direction = toApply.length > 0 ? "apply" : toRemove.length > 0 ? "remove" : null;
  const targets = direction === "apply" ? toApply : toRemove;
  // Environments finish one by one, so the row says what is running, not what the states now suggest.
  const running =
    devices.find((device) => device.work.changing?.patchId === patch.id)?.work.changing ?? null;
  const action = running?.direction ?? direction;
  const blocked = targets.some(({ work }) => isHermesPatchWorkBusy(work));
  const shared = states.every((entry) => entry.patch.state === states[0]?.patch.state)
    ? states[0]?.patch
    : undefined;

  return (
    <SettingsRow
      title={<PatchTitle title={patch.title} state={shared?.state} />}
      description={describeHermesPatchNeed(patch)}
      status={
        <>
          {shared === undefined ? null : <p>{describeHermesPatchHint(shared)}</p>}
          <ul className="mt-1.5 flex flex-col gap-1">
            {states.map(({ device, patch: onDevice }) => (
              <li key={device.environmentId} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{labelOf(device.environmentId)}</span>
                <Badge variant={STATE_BADGE[onDevice.state]} size="sm">
                  {HERMES_PATCH_STATE_LABELS[onDevice.state]}
                </Badge>
                {shared === undefined && onDevice.state === "doesNotApply" ? (
                  <span className="min-w-0 truncate">{describeHermesPatchHint(onDevice)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      }
      control={
        action === null ? null : (
          <Button
            size="sm"
            variant={action === "apply" ? "default" : "outline"}
            disabled={running !== null || blocked}
            onClick={action === "apply" ? onApply : onRemove}
          >
            {running !== null
              ? running.direction === "apply"
                ? "Applying…"
                : "Removing…"
              : targets.length === states.length
                ? action === "apply"
                  ? "Apply everywhere"
                  : "Remove everywhere"
                : `${action === "apply" ? "Apply on" : "Remove from"} ${targets.length} ${
                    targets.length === 1 ? "environment" : "environments"
                  }`}
          </Button>
        )
      }
    />
  );
}
