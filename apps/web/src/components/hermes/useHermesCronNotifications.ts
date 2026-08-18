/**
 * Turns finished Hermes runs into a toast and a sidebar dot.
 *
 * Mounted from the sidebar footer rather than the panel, because a dot that
 * only lights while you are already looking at the panel would be pointless.
 * That does mean a client with Hermes holds one cron subscription for as long
 * as it is connected — which is the same thing "at least one client is
 * subscribed" means to the environment, and costs one small frame per change.
 */
import { useEffect, useRef } from "react";

import { useHermesCron } from "../../state/hermesCron";
import { reportHermesCompletionSeq } from "../../state/hermesCronSeen";
import { toastManager } from "../ui/toast";

export function useHermesCronNotifications(): void {
  const { view, environmentId } = useHermesCron();
  const lastToastedSeq = useRef(0);

  useEffect(() => {
    const { completionSeq, lastCompletion } = view;
    if (environmentId === null || completionSeq === 0 || lastCompletion === null) return;
    if (completionSeq === lastToastedSeq.current) return;
    lastToastedSeq.current = completionSeq;

    reportHermesCompletionSeq(environmentId, completionSeq);
    toastManager.add(
      lastCompletion.status === "failed"
        ? {
            type: "error",
            title: `Task failed: ${lastCompletion.jobName}`,
            description: lastCompletion.error ?? "Hermes did not record a reason.",
          }
        : {
            type: "success",
            title: `Task finished: ${lastCompletion.jobName}`,
            description: "Scheduled run completed.",
          },
    );
  }, [environmentId, view]);
}
