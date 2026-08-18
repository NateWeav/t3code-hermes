import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HERMES_CRON_CONTRACT_VERSION,
  HermesCronJobId,
  HermesCronListInput,
  HermesCronSetEnabledInput,
  HermesCronSetMutedInput,
  HermesCronSnapshot,
  HermesCronStreamEvent,
} from "./hermesCron.ts";

const decodeSnapshot = Schema.decodeUnknownSync(HermesCronSnapshot);
const encodeSnapshot = Schema.encodeSync(HermesCronSnapshot);
const decodeStreamEvent = Schema.decodeUnknownSync(HermesCronStreamEvent);
const encodeStreamEvent = Schema.encodeSync(HermesCronStreamEvent);
const decodeListInput = Schema.decodeUnknownSync(HermesCronListInput);
const decodeSetEnabled = Schema.decodeUnknownSync(HermesCronSetEnabledInput);
const decodeSetMuted = Schema.decodeUnknownSync(HermesCronSetMutedInput);

const JOB_ID = Schema.decodeUnknownSync(HermesCronJobId)("job-1");

const SNAPSHOT: HermesCronSnapshot = {
  contractVersion: HERMES_CRON_CONTRACT_VERSION,
  readAt: "2026-08-16T09:05:00.000Z",
  availability: "ready",
  detail: null,
  runHistoryAvailable: true,
  jobs: [
    {
      id: JOB_ID,
      name: "Morning digest",
      scheduleDisplay: "every day at 09:00",
      state: "scheduled",
      enabled: true,
      nextRunAt: "2026-08-17T09:00:00Z",
      lastRunAt: "2026-08-16T09:00:31Z",
      lastStatus: "ok",
      lastError: null,
      deliver: ["local", "telegram"],
      muted: false,
      runs: [
        {
          id: "exec-2",
          jobId: JOB_ID,
          status: "failed",
          source: "ticker",
          claimedAt: "2026-08-16T09:00:00Z",
          startedAt: "2026-08-16T09:00:01Z",
          finishedAt: "2026-08-16T09:00:04Z",
          durationMs: 3_000,
          error: "provider timeout",
        },
        {
          id: "exec-1",
          jobId: JOB_ID,
          status: "completed",
          source: "manual",
          claimedAt: "2026-08-15T09:00:00Z",
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          error: null,
        },
      ],
    },
  ],
};

describe("HermesCronSnapshot", () => {
  it("round-trips a populated snapshot", () => {
    expect(decodeSnapshot(encodeSnapshot(SNAPSHOT))).toEqual(SNAPSHOT);
  });

  it("round-trips each availability state with no jobs", () => {
    for (const availability of ["providerDisabled", "noCronStore", "unreadable"] as const) {
      const snapshot: HermesCronSnapshot = {
        ...SNAPSHOT,
        availability,
        detail: availability === "unreadable" ? "The cron store could not be read." : null,
        runHistoryAvailable: false,
        jobs: [],
      };
      expect(decodeSnapshot(encodeSnapshot(snapshot))).toEqual(snapshot);
    }
  });

  it("rejects a snapshot from a future contract version", () => {
    expect(() => decodeSnapshot({ ...encodeSnapshot(SNAPSHOT), contractVersion: 99 })).toThrow();
  });

  it("drops a run whose status Hermes did not define at this version", () => {
    // A future Hermes could add a sixth status. Losing that one row keeps the
    // rest of the panel readable; the server-side parser test is the tripwire
    // that makes the upgrade visible to us.
    const encoded = encodeSnapshot(SNAPSHOT) as unknown as {
      jobs: { runs: { status: string; id: string }[] }[];
    };
    encoded.jobs[0]!.runs[0]!.status = "cancelled";
    const decoded = decodeSnapshot(encoded);
    expect(decoded.jobs[0]?.runs.map((run) => run.id)).toEqual(["exec-1"]);
  });

  it("drops forward-incompatible jobs rather than failing the whole snapshot", () => {
    const encoded = encodeSnapshot(SNAPSHOT) as unknown as { jobs: unknown[] };
    encoded.jobs = [...encoded.jobs, { id: "job-2", unexpected: true }];
    const decoded = decodeSnapshot(encoded);
    expect(decoded.jobs.map((job) => job.id)).toEqual([JOB_ID]);
  });
});

describe("HermesCronStreamEvent", () => {
  it("round-trips a snapshot event", () => {
    const event: HermesCronStreamEvent = { _tag: "snapshot", snapshot: SNAPSHOT };
    expect(decodeStreamEvent(encodeStreamEvent(event))).toEqual(event);
  });

  it("round-trips a completed-run event", () => {
    const event: HermesCronStreamEvent = {
      _tag: "runCompleted",
      run: {
        jobId: JOB_ID,
        jobName: "Morning digest",
        runId: "exec-3",
        status: "failed",
        finishedAt: "2026-08-16T10:00:04Z",
        error: "disk full",
      },
    };
    expect(decodeStreamEvent(encodeStreamEvent(event))).toEqual(event);
  });

  it("only admits terminal statuses on a run event", () => {
    expect(() =>
      decodeStreamEvent({
        _tag: "runCompleted",
        run: {
          jobId: "job-1",
          jobName: "Morning digest",
          runId: "exec-3",
          status: "running",
          finishedAt: null,
          error: null,
        },
      }),
    ).toThrow();
  });
});

describe("Hermes cron request inputs", () => {
  it("treats refresh as optional", () => {
    expect(decodeListInput({})).toEqual({});
    expect(decodeListInput({ refresh: true })).toEqual({ refresh: true });
  });

  it("round-trips both directions of the reversible mutations", () => {
    for (const enabled of [true, false]) {
      expect(decodeSetEnabled({ jobId: "job-1", enabled })).toEqual({ jobId: JOB_ID, enabled });
    }
    for (const muted of [true, false]) {
      expect(decodeSetMuted({ jobId: "job-1", muted })).toEqual({ jobId: JOB_ID, muted });
    }
  });

  it("rejects a blank job id", () => {
    expect(() => decodeSetEnabled({ jobId: "  ", enabled: true })).toThrow();
  });
});
