/**
 * Decides which Hermes cron runs deserve a notification.
 *
 * Kept separate from the polling service so the rule that actually matters —
 * never notify about history — is testable without a clock, a socket, or a
 * Hermes install.
 *
 * @module hermesCronNotifications
 */
import type { ParsedHermesCronJob, ParsedHermesCronRun } from "./hermesCronState.ts";

/**
 * Statuses worth telling someone about. `claimed` and `running` are in-flight,
 * and `unknown` means Hermes could not prove what happened — announcing either
 * would be a lie of a different kind.
 */
const NOTIFIABLE = new Set<string>(["completed", "failed"]);

export interface HermesCronRunNotification {
  readonly jobId: string;
  readonly jobName: string;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly finishedAt: string | null;
  readonly error: string | null;
}

/**
 * The slice of a previous poll needed to tell new outcomes from old ones:
 * every run id seen last time, mapped to the status it had then.
 *
 * `null` means "no previous poll" — the service has just started, or the
 * provider was just enabled.
 */
export type HermesCronRunLedger = ReadonlyMap<string, string>;

export function buildRunLedger(runs: readonly ParsedHermesCronRun[]): HermesCronRunLedger {
  const ledger = new Map<string, string>();
  for (const run of runs) ledger.set(run.id, run.status);
  return ledger;
}

export interface DiffRunsInput {
  readonly jobs: readonly ParsedHermesCronJob[];
  readonly runs: readonly ParsedHermesCronRun[];
  /** `null` on the very first poll of a service lifetime. */
  readonly previous: HermesCronRunLedger | null;
  readonly mutedJobIds: ReadonlySet<string>;
}

/**
 * Returns the runs that reached a terminal state since the previous poll.
 *
 * The first poll always returns nothing. A server that restarts overnight
 * would otherwise wake up, read a ledger full of runs it has never seen, and
 * fire a notification for every one of them — the single worst thing this
 * feature could do. "New" is therefore defined strictly against a previous
 * observation, never against a timestamp.
 *
 * A run that was in flight last poll and is terminal now counts as new, so a
 * long-running job still notifies exactly once when it lands.
 */
export function diffCompletedRuns(input: DiffRunsInput): readonly HermesCronRunNotification[] {
  if (input.previous === null) return [];

  const jobNames = new Map(input.jobs.map((job) => [job.id, job.name] as const));
  const notifications: HermesCronRunNotification[] = [];

  for (const run of input.runs) {
    if (!NOTIFIABLE.has(run.status)) continue;
    if (input.mutedJobIds.has(run.jobId)) continue;

    const seenStatus = input.previous.get(run.id);
    // Already terminal when we last looked — nothing changed.
    if (seenStatus !== undefined && NOTIFIABLE.has(seenStatus)) continue;

    notifications.push({
      jobId: run.jobId,
      jobName: jobNames.get(run.jobId) ?? run.jobId,
      runId: run.id,
      status: run.status as "completed" | "failed",
      finishedAt: run.finishedAt,
      error: run.error,
    });
  }

  // Oldest first, so a burst of notifications reads in the order things
  // actually happened.
  return notifications.toReversed();
}

/** Notification copy. Kept here so the wording is covered by the diff tests. */
export function describeRunNotification(notification: HermesCronRunNotification): {
  readonly title: string;
  readonly body: string;
} {
  if (notification.status === "failed") {
    return {
      title: `Task failed: ${notification.jobName}`,
      body: notification.error ?? "Hermes did not record a reason.",
    };
  }
  return {
    title: `Task finished: ${notification.jobName}`,
    body: "Scheduled run completed.",
  };
}
