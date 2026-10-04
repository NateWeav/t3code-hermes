/**
 * Patches tab — the fork's patches to Hermes itself, and where each stands in
 * the environment's Hermes checkout. Decisions live in `useHermesPatches`.
 */
import {
  describeHermesGateway,
  describeHermesPatchesUnavailable,
  describeHermesPatchHint,
  HERMES_DETACHED_HEAD_WARNING,
  HERMES_PATCH_STATE_LABELS,
  HERMES_UPDATE_DESCRIPTION,
  HERMES_UPDATE_LABEL,
  HERMES_UPDATE_PENDING_LABEL,
  shouldOfferHermesUpdate,
} from "@t3tools/client-runtime/state/hermes-patches";
import type { HermesPatch, HermesPatchState } from "@t3tools/contracts";
import { InfoIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";

import { useHermesPatches } from "../../state/hermesPatches";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";

const STATE_BADGE: Record<HermesPatchState, "success" | "info" | "warning"> = {
  applied: "success",
  notApplied: "info",
  doesNotApply: "warning",
};

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
    <li className="flex items-start gap-3 rounded-lg border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{patch.title}</p>
          <Badge variant={STATE_BADGE[patch.state]}>{HERMES_PATCH_STATE_LABELS[patch.state]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Needed for {patch.neededFor}</p>
        <p className="mt-1 text-xs text-muted-foreground">{describeHermesPatchHint(patch)}</p>
      </div>
      {patch.state === "notApplied" ? (
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
      ) : null}
    </li>
  );
}

export function HermesPatchesTab() {
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
    requestingRestart,
    restartGateway,
  } = useHermesPatches();

  if (isPending) {
    return (
      <ul className="flex flex-col gap-2" aria-hidden>
        <li className="rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-1.5 h-4 w-64" />
        </li>
      </ul>
    );
  }

  if (snapshot === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Patches are unavailable</EmptyTitle>
          <EmptyDescription>{error ?? "No environment with Hermes is connected."}</EmptyDescription>
        </EmptyHeader>
        <Button onClick={refresh} variant="ghost">
          <RefreshCwIcon />
          Try again
        </Button>
      </Empty>
    );
  }

  const unavailable = describeHermesPatchesUnavailable(snapshot);
  if (unavailable !== null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{unavailable.title}</EmptyTitle>
          <EmptyDescription>{unavailable.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const gateway = describeHermesGateway(snapshot.gateway, snapshot.gatewayRestartFailure);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Hermes checkout: <span className="font-mono">{snapshot.checkoutPath}</span>
        </p>
        <Button size="xs" variant="ghost" disabled={updating} onClick={refresh}>
          <RefreshCwIcon />
          Check again
        </Button>
      </div>
      {shouldOfferHermesUpdate(snapshot) || updating ? (
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>{HERMES_UPDATE_DESCRIPTION}</AlertDescription>
          <AlertAction>
            <Button size="sm" disabled={busy} onClick={updateHermes}>
              {updating ? HERMES_UPDATE_PENDING_LABEL : HERMES_UPDATE_LABEL}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {updateSummary === null ? null : (
        <p className="text-xs text-muted-foreground" role="status">
          {updateSummary}
        </p>
      )}
      {snapshot.detachedHead ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>{HERMES_DETACHED_HEAD_WARNING}</AlertDescription>
        </Alert>
      ) : null}
      {gateway !== null ? (
        <Alert variant={gateway.tone}>
          {gateway.tone === "info" ? <InfoIcon /> : <TriangleAlertIcon />}
          <AlertDescription>{gateway.text}</AlertDescription>
          {gateway.restart ? (
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                disabled={requestingRestart || busy}
                onClick={restartGateway}
              >
                <RotateCwIcon />
                {requestingRestart ? "Restarting…" : "Restart gateway"}
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}
      {snapshot.patches.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This T3 Code release carries no Hermes patches.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {snapshot.patches.map((patch) => (
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
          ))}
        </ul>
      )}
    </div>
  );
}
