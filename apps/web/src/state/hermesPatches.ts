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
import type { HermesPatchId } from "@t3tools/contracts";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useHermesEnvironmentId } from "./hermesCron";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export function useHermesPatches() {
  const environmentId = useHermesEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesPatches({ environmentId, input: {} }),
  );
  const applyCommand = useAtomCommand(serverEnvironment.hermesPatchApply);
  const revertCommand = useAtomCommand(serverEnvironment.hermesPatchRevert);
  const updateCommand = useAtomCommand(serverEnvironment.hermesPatchUpdateHermes);
  const [changingPatchId, setChangingPatchId] = useState<HermesPatchId | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateSummary, setUpdateSummary] = useState<string | null>(null);
  const refresh = query.refresh;
  const busy = changingPatchId !== null || updating;

  const change = async (patchId: HermesPatchId, direction: "apply" | "remove") => {
    if (environmentId === null || busy) return;
    setChangingPatchId(patchId);
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
      setChangingPatchId(null);
      // Success or not, the checkout is the source of truth: read it again.
      refresh();
    }
  };

  /** Removes the patches, updates Hermes, and reapplies; the outcome stays as a line in the tab. */
  const updateHermes = async () => {
    if (environmentId === null || busy) return;
    setUpdating(true);
    setUpdateSummary(null);
    try {
      const result = await updateCommand({ environmentId, input: {} });
      if (result._tag === "Success") {
        setUpdateSummary(describeHermesUpdateResult(result.value));
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
      setUpdating(false);
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
  };
}
