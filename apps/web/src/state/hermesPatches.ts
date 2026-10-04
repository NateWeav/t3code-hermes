/**
 * Everything the Patches tab decides: which environment, the latest read of
 * its Hermes checkout, and what applying or removing a patch, or updating
 * Hermes, does afterwards.
 *
 * @module state/hermesPatches
 */
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

import { toastManager } from "../components/ui/toast";
import { useHermesEnvironmentId } from "./hermesCron";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const GATEWAY_RESTART_POLL_MS = 2_000;

export function useHermesPatches() {
  const environmentId = useHermesEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesPatches({ environmentId, input: {} }),
  );
  const applyCommand = useAtomCommand(serverEnvironment.hermesPatchApply);
  const revertCommand = useAtomCommand(serverEnvironment.hermesPatchRevert);
  const updateCommand = useAtomCommand(serverEnvironment.hermesPatchUpdateHermes);
  // In-flight work is kept with the environment it runs against, so switching
  // environments mid-change never shows, or blocks on, another's progress.
  const [changing, setChanging] = useState<{
    readonly environmentId: EnvironmentId;
    readonly patchId: HermesPatchId;
  } | null>(null);
  const [updatingIn, setUpdatingIn] = useState<EnvironmentId | null>(null);
  const changingPatchId = changing?.environmentId === environmentId ? changing.patchId : null;
  const updating = updatingIn !== null && updatingIn === environmentId;
  // Kept with the environment it describes, so switching environments, even
  // mid-update, never shows one environment's result against another's.
  const [summary, setSummary] = useState<{
    readonly environmentId: EnvironmentId;
    readonly text: string;
  } | null>(null);
  const updateSummary = summary?.environmentId === environmentId ? summary.text : null;
  const refresh = query.refresh;
  const busy = changingPatchId !== null || updating;
  const restartCommand = useAtomCommand(serverEnvironment.hermesGatewayRestart);
  const [requestingRestart, setRequestingRestart] = useState(false);
  const restarting = query.data?.gateway?.state === "restarting";

  // The restart runs on the server after the request returns; re-read until it is done.
  useEffect(() => {
    if (!restarting) return;
    const timer = window.setInterval(refresh, GATEWAY_RESTART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [restarting, refresh]);

  const restartGateway = async () => {
    if (environmentId === null || busy || requestingRestart || restarting) return;
    setRequestingRestart(true);
    try {
      const result = await restartCommand({ environmentId, input: {} });
      if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Gateway not restarted",
          description: describeHermesPatchFailure(
            squashAtomCommandFailure(result),
            "The Hermes gateway could not be restarted.",
          ),
        });
      }
    } finally {
      setRequestingRestart(false);
      refresh();
    }
  };

  const change = async (patchId: HermesPatchId, direction: "apply" | "remove") => {
    if (environmentId === null || busy) return;
    setChanging({ environmentId, patchId });
    try {
      const command = direction === "apply" ? applyCommand : revertCommand;
      const result = await command({ environmentId, input: { patchId } });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: direction === "apply" ? "Patch applied" : "Patch removed",
          description: "New Hermes sessions pick this up. Running sessions keep what they had.",
        });
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: direction === "apply" ? "Patch not applied" : "Patch not removed",
          description: describeHermesPatchFailure(
            squashAtomCommandFailure(result),
            "The Hermes checkout could not be changed.",
          ),
        });
      }
    } finally {
      setChanging(null);
      // Success or not, the checkout is the source of truth: read it again.
      refresh();
    }
  };

  /** Removes the patches, updates Hermes, and reapplies; the outcome stays as a line in the tab. */
  const updateHermes = async () => {
    if (environmentId === null || busy) return;
    setUpdatingIn(environmentId);
    setSummary(null);
    try {
      const result = await updateCommand({ environmentId, input: {} });
      if (result._tag === "Success") {
        setSummary({ environmentId, text: describeHermesUpdateResult(result.value) });
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Hermes not updated",
          description: describeHermesPatchFailure(
            squashAtomCommandFailure(result),
            "Hermes could not be updated.",
          ),
        });
      }
    } finally {
      setUpdatingIn(null);
      refresh();
    }
  };

  return {
    environmentId,
    snapshot: query.data,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
    changingPatchId,
    updating,
    updateSummary,
    busy,
    refresh,
    updateHermes: () => void updateHermes(),
    apply: (patchId: HermesPatchId) => void change(patchId, "apply"),
    remove: (patchId: HermesPatchId) => void change(patchId, "remove"),
    requestingRestart,
    restartGateway: () => void restartGateway(),
  };
}
