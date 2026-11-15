import {
  isLiveSubagentShell,
  type HostResourcesSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const LOAD_SAMPLE_INTERVAL_MS = 15_000;
export const SUSTAINED_LOAD_MS = 60_000;
const MOVE_COOLDOWN_MS = 10 * 60_000;

export function isOverloaded(snapshot: HostResourcesSnapshot): boolean {
  return (
    (snapshot.cpuUtilization !== null && snapshot.cpuUtilization >= 0.9) ||
    (snapshot.totalMemoryBytes > 0 &&
      snapshot.availableMemoryBytes / snapshot.totalMemoryBytes <= 0.1)
  );
}

export function hasSpareCapacity(snapshot: HostResourcesSnapshot): boolean {
  return (
    snapshot.cpuUtilization !== null &&
    snapshot.cpuUtilization <= 0.6 &&
    snapshot.totalMemoryBytes > 0 &&
    snapshot.availableMemoryBytes / snapshot.totalMemoryBytes >= 0.2 &&
    snapshot.availableMemoryBytes >= 2 * 1024 ** 3
  );
}

export const isWorkingShell = (thread: OrchestrationV2ThreadShell) =>
  thread.status === "preparing" || thread.status === "starting" || thread.status === "running";

export function canAutomaticallyMove(
  thread: OrchestrationV2ThreadShell,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  nowMs: number,
): boolean {
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.lineage.parentThreadId !== null ||
    thread.hermesRun != null ||
    thread.delegatedFrom != null ||
    thread.latestRunId === null ||
    thread.pendingRuntimeRequest !== null ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return false;
  if (
    thread.move != null &&
    (thread.move.direction === "outgoing" ||
      thread.move.phase !== "complete" ||
      nowMs - Date.parse(thread.move.startedAt) < MOVE_COOLDOWN_MS)
  )
    return false;
  return !threads.some(
    (other) =>
      other.id !== thread.id &&
      isLiveSubagentShell(other) &&
      (thread.worktreePath !== null && other.worktreePath !== null
        ? thread.worktreePath === other.worktreePath
        : thread.projectId === other.projectId),
  );
}
