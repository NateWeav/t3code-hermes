/**
 * React binding for the shared Hermes "something happened while you were
 * looking elsewhere" store.
 *
 * The store itself lives in client-runtime so mobile can light the same dot;
 * only the subscription primitive is per-platform.
 */
import {
  hasUnseenHermesCompletions,
  subscribeHermesTasksSeen,
} from "@t3tools/client-runtime/state/hermes-cron-seen";
import { useSyncExternalStore } from "react";
import { useHermesEnvironmentId } from "./hermesCron";

export {
  markHermesTasksSeen,
  reportHermesCompletionSeq,
} from "@t3tools/client-runtime/state/hermes-cron-seen";

export function useHermesTasksUnread(): boolean {
  const environmentId = useHermesEnvironmentId();
  return useSyncExternalStore(
    subscribeHermesTasksSeen,
    () => environmentId !== null && hasUnseenHermesCompletions(environmentId),
    () => false,
  );
}
