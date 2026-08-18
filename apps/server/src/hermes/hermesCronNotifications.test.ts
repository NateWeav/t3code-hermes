import { describe, expect, it } from "@effect/vitest";

import {
  buildRunLedger,
  describeRunNotification,
  diffCompletedRuns,
} from "./hermesCronNotifications.ts";
import type { ParsedHermesCronJob, ParsedHermesCronRun } from "./hermesCronState.ts";

const JOBS = [
  { id: "job-1", name: "Morning digest" },
  { id: "job-2", name: "Disk watchdog" },
] as unknown as readonly ParsedHermesCronJob[];

function run(overrides: Partial<ParsedHermesCronRun> & { id: string }): ParsedHermesCronRun {
  return {
    jobId: "job-1",
    status: "completed",
    source: "ticker",
    claimedAt: "2026-08-16T09:00:00Z",
    startedAt: "2026-08-16T09:00:01Z",
    finishedAt: "2026-08-16T09:00:31Z",
    durationMs: 30_000,
    error: null,
    ...overrides,
  };
}

describe("diffCompletedRuns", () => {
  it("never notifies on the first poll, however much history exists", () => {
    const notifications = diffCompletedRuns({
      jobs: JOBS,
      runs: [run({ id: "exec-1" }), run({ id: "exec-2" }), run({ id: "exec-3" })],
      previous: null,
      mutedJobIds: new Set(),
    });
    expect(notifications).toEqual([]);
  });

  it("notifies for a run that appeared since the previous poll", () => {
    const previous = buildRunLedger([run({ id: "exec-1" })]);
    const notifications = diffCompletedRuns({
      jobs: JOBS,
      runs: [run({ id: "exec-2" }), run({ id: "exec-1" })],
      previous,
      mutedJobIds: new Set(),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      runId: "exec-2",
      jobId: "job-1",
      jobName: "Morning digest",
      status: "completed",
    });
  });

  it("notifies for a failure and carries the recorded reason", () => {
    const notifications = diffCompletedRuns({
      jobs: JOBS,
      runs: [run({ id: "exec-9", status: "failed", error: "provider timeout" })],
      previous: buildRunLedger([]),
      mutedJobIds: new Set(),
    });
    expect(notifications[0]).toMatchObject({ status: "failed", error: "provider timeout" });
  });

  it("notifies once when a run that was in flight lands", () => {
    const previous = buildRunLedger([run({ id: "exec-1", status: "running" })]);
    const first = diffCompletedRuns({
      jobs: JOBS,
      runs: [run({ id: "exec-1", status: "completed" })],
      previous,
      mutedJobIds: new Set(),
    });
    expect(first).toHaveLength(1);

    // Same run, now already terminal in the ledger — must stay quiet.
    const second = diffCompletedRuns({
      jobs: JOBS,
      runs: [run({ id: "exec-1", status: "completed" })],
      previous: buildRunLedger([run({ id: "exec-1", status: "completed" })]),
      mutedJobIds: new Set(),
    });
    expect(second).toEqual([]);
  });

  it("stays quiet for in-flight and unknown outcomes", () => {
    const notifications = diffCompletedRuns({
      jobs: JOBS,
      runs: [
        run({ id: "exec-1", status: "claimed" }),
        run({ id: "exec-2", status: "running" }),
        run({ id: "exec-3", status: "unknown" }),
      ],
      previous: buildRunLedger([]),
      mutedJobIds: new Set(),
    });
    expect(notifications).toEqual([]);
  });

  it("suppresses muted jobs while still notifying the others", () => {
    const notifications = diffCompletedRuns({
      jobs: JOBS,
      runs: [
        run({ id: "exec-1", jobId: "job-1" }),
        run({ id: "exec-2", jobId: "job-2", status: "failed", error: "disk full" }),
      ],
      previous: buildRunLedger([]),
      mutedJobIds: new Set(["job-1"]),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ jobId: "job-2", status: "failed" });
  });

  it("reports a burst oldest-first", () => {
    const notifications = diffCompletedRuns({
      jobs: JOBS,
      // The ledger query orders newest-first.
      runs: [run({ id: "exec-3" }), run({ id: "exec-2" }), run({ id: "exec-1" })],
      previous: buildRunLedger([]),
      mutedJobIds: new Set(),
    });
    expect(notifications.map((entry) => entry.runId)).toEqual(["exec-1", "exec-2", "exec-3"]);
  });

  it("falls back to the job id when the job record is gone", () => {
    const notifications = diffCompletedRuns({
      jobs: [],
      runs: [run({ id: "exec-1", jobId: "job-deleted" })],
      previous: buildRunLedger([]),
      mutedJobIds: new Set(),
    });
    expect(notifications[0]?.jobName).toBe("job-deleted");
  });
});

describe("describeRunNotification", () => {
  it("names the job and the reason for a failure", () => {
    const described = describeRunNotification({
      jobId: "job-1",
      jobName: "Morning digest",
      runId: "exec-1",
      status: "failed",
      finishedAt: null,
      error: "provider timeout",
    });
    expect(described.title).toBe("Task failed: Morning digest");
    expect(described.body).toBe("provider timeout");
  });

  it("does not invent a reason when Hermes recorded none", () => {
    const described = describeRunNotification({
      jobId: "job-1",
      jobName: "Morning digest",
      runId: "exec-1",
      status: "failed",
      finishedAt: null,
      error: null,
    });
    expect(described.body).toBe("Hermes did not record a reason.");
  });
});
