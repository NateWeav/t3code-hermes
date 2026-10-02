import {
  describeHermesPatchFailure,
  describeHermesUpdateResult,
} from "@t3tools/client-runtime/state/hermes-patches";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HermesPatchId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

/**
 * The Patches tab's read of one environment's Hermes checkout. `change` and
 * `updateHermes` resolve to null on success, or the reason to show when they
 * failed; a finished update leaves its outcome in `updateSummary`.
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
  const [changingPatchId, setChangingPatchId] = useState<HermesPatchId | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateSummary, setUpdateSummary] = useState<string | null>(null);
  const refresh = query.refresh;
  const busy = changingPatchId !== null || updating;

  const change = async (
    patchId: HermesPatchId,
    direction: "apply" | "remove",
  ): Promise<string | null> => {
    if (environmentId === null || busy) return null;
    setChangingPatchId(patchId);
    try {
      const command = direction === "apply" ? applyCommand : revertCommand;
      const result = await command({ environmentId, input: { patchId } });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
      return describeHermesPatchFailure(
        squashAtomCommandFailure(result),
        "The Hermes checkout could not be changed.",
      );
    } finally {
      setChangingPatchId(null);
      // Success or not, the checkout is the source of truth: read it again.
      refresh();
    }
  };

  const updateHermes = async (): Promise<string | null> => {
    if (environmentId === null || busy) return null;
    setUpdating(true);
    setUpdateSummary(null);
    try {
      const result = await updateCommand({ environmentId, input: {} });
      if (result._tag === "Success") {
        setUpdateSummary(describeHermesUpdateResult(result.value));
        return null;
      }
      if (isAtomCommandInterrupted(result)) return null;
      return describeHermesPatchFailure(
        squashAtomCommandFailure(result),
        "Hermes could not be updated.",
      );
    } finally {
      setUpdating(false);
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
  };
}
