/**
 * Everything the Patches tab decides: which environment, the latest read of
 * its Hermes checkout, and what applying or removing a patch does afterwards.
 *
 * @module state/hermesPatches
 */
import { describeHermesPatchFailure } from "@t3tools/client-runtime/state/hermes-patches";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { HermesPatchId } from "@t3tools/contracts";
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
  const restartCommand = useAtomCommand(serverEnvironment.hermesGatewayRestart);
  const [changingPatchId, setChangingPatchId] = useState<HermesPatchId | null>(null);
  const [requestingRestart, setRequestingRestart] = useState(false);
  const refresh = query.refresh;
  const restarting = query.data?.gateway?.state === "restarting";

  // The restart runs on the server after the request returns; re-read until it is done.
  useEffect(() => {
    if (!restarting) return;
    const timer = window.setInterval(refresh, GATEWAY_RESTART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [restarting, refresh]);

  const restartGateway = async () => {
    if (environmentId === null || requestingRestart || restarting) return;
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
    if (environmentId === null || changingPatchId !== null) return;
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

  return {
    environmentId,
    snapshot: query.data,
    isPending: query.isPending && query.data === null,
    error: query.data === null ? query.error : null,
    changingPatchId,
    refresh,
    apply: (patchId: HermesPatchId) => void change(patchId, "apply"),
    remove: (patchId: HermesPatchId) => void change(patchId, "remove"),
    requestingRestart,
    restartGateway: () => void restartGateway(),
  };
}
