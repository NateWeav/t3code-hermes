import {
  describeHermesPatchFailure,
  describeHermesUpdateResult,
} from "@t3tools/client-runtime/state/hermes-patches";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HermesPatchId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const GATEWAY_RESTART_POLL_MS = 2_000;

/** The record minus one environment's entry. */
const without = <V>(
  record: Partial<Record<EnvironmentId, V>>,
  environmentId: EnvironmentId,
): Partial<Record<EnvironmentId, V>> => {
  const next = { ...record };
  delete next[environmentId];
  return next;
};

/**
 * The Patches tab's read of one environment's Hermes checkout. `change`,
 * `updateHermes` and `restartGateway` resolve to null on success, or the
 * reason to show when they failed; a finished update leaves its outcome in
 * `updateSummary`.
 */
export function useHermesPatches(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesPatches({ environmentId, input: {} }),
  );
  const applyCommand = useAtomCommand(serverEnvironment.hermesPatchApply, {
    reportFailure: false,
  });
  const revertCommand = useAtomCommand(serverEnvironment.hermesPatchRevert, {
    reportFailure: false,
  });
  const updateCommand = useAtomCommand(serverEnvironment.hermesPatchUpdateHermes, {
    reportFailure: false,
  });
  // Per environment: work can be running in several at once, and switching
  // environments must neither show nor clear another's progress or result.
  const [changing, setChanging] = useState<Partial<Record<EnvironmentId, HermesPatchId>>>({});
  const [updatingIn, setUpdatingIn] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [summaries, setSummaries] = useState<Partial<Record<EnvironmentId, string>>>({});
  const changingPatchId = environmentId === null ? null : (changing[environmentId] ?? null);
  const updating = environmentId !== null && updatingIn.has(environmentId);
  const updateSummary = environmentId === null ? null : (summaries[environmentId] ?? null);
  const refresh = query.refresh;
  const busy = changingPatchId !== null || updating;
  const restartCommand = useAtomCommand(serverEnvironment.hermesGatewayRestart, {
    reportFailure: false,
  });
  const [requestingRestart, setRequestingRestart] = useState(false);
  const restarting = query.data?.gateway?.state === "restarting";

  // The restart runs on the server after the request returns; re-read until it is done.
  useEffect(() => {
    if (!restarting) return;
    const timer = setInterval(refresh, GATEWAY_RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [restarting, refresh]);

  /** Resolves to null once the restart started, or the reason it did not. */
  const restartGateway = async (): Promise<string | null> => {
    if (environmentId === null || busy || requestingRestart || restarting) return null;
    setRequestingRestart(true);
    try {
      const result = await restartCommand({ environmentId, input: {} });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
      return describeHermesPatchFailure(
        squashAtomCommandFailure(result),
        "The Hermes gateway could not be restarted.",
      );
    } finally {
      setRequestingRestart(false);
      refresh();
    }
  };

  const change = async (
    patchId: HermesPatchId,
    direction: "apply" | "remove",
  ): Promise<string | null> => {
    if (environmentId === null || busy) return null;
    setChanging((current) => ({ ...current, [environmentId]: patchId }));
    try {
      const command = direction === "apply" ? applyCommand : revertCommand;
      const result = await command({ environmentId, input: { patchId } });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
      return describeHermesPatchFailure(
        squashAtomCommandFailure(result),
        "The Hermes checkout could not be changed.",
      );
    } finally {
      setChanging((current) => without(current, environmentId));
      // Success or not, the checkout is the source of truth: read it again.
      refresh();
    }
  };

  const updateHermes = async (): Promise<string | null> => {
    if (environmentId === null || busy) return null;
    setUpdatingIn((current) => new Set(current).add(environmentId));
    setSummaries((current) => without(current, environmentId));
    try {
      const result = await updateCommand({ environmentId, input: {} });
      if (result._tag === "Success") {
        const text = describeHermesUpdateResult(result.value);
        setSummaries((current) => ({ ...current, [environmentId]: text }));
        return null;
      }
      if (isAtomCommandInterrupted(result)) return null;
      return describeHermesPatchFailure(
        squashAtomCommandFailure(result),
        "Hermes could not be updated.",
      );
    } finally {
      setUpdatingIn((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
      refresh();
    }
  };

  return {
    snapshot: query.data,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
    changingPatchId,
    updating,
    updateSummary,
    busy,
    refresh,
    change,
    updateHermes,
    requestingRestart,
    restartGateway,
  };
}
