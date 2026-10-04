import { assert, it } from "@effect/vitest";

import {
  hermesNotificationReport,
  hermesProcessMutation,
  type HermesProcessReport,
} from "./HermesBackground.ts";

const running: HermesProcessReport = {
  sessionId: "acp-1",
  toolCallId: "tc-1",
  processId: "proc_1",
  command: "npm run dev\nsecond line",
  status: "running",
};

it("keys a background process by its Hermes process id and names it by command", () => {
  assert.deepEqual(hermesProcessMutation(running), {
    sessionId: "acp-1",
    taskId: "proc_1",
    status: "running",
    report: { kind: "command", label: "npm run dev" },
  });
});

it("settles each exit reason as the matching task status", () => {
  const cases: Array<[Partial<HermesProcessReport>, string]> = [
    [{ exitCode: 0, reason: "exited" }, "completed"],
    [{ exitCode: 2, reason: "exited" }, "failed"],
    [{ exitCode: -15, reason: "killed" }, "completed"],
    [{ exitCode: null, reason: "lost" }, "failed"],
    [{ reason: "failed_start" }, "failed"],
  ];
  for (const [exit, status] of cases) {
    const mutation = hermesProcessMutation({ ...running, status: "exited", ...exit });
    assert.equal(mutation.status, status, JSON.stringify(exit));
  }
  assert.deepInclude(hermesProcessMutation({ ...running, status: "exited", exitCode: 2 }).report, {
    exitCode: 2,
  });
});

it("names the work a Hermes wake notice reports", () => {
  assert.deepEqual(
    hermesNotificationReport({
      sessionId: "acp-1",
      kind: "subagent_result",
      title: " Review parser ",
      text: "done",
    }),
    { kind: "subagent", label: "Review parser", outcome: "completed" },
  );
  assert.equal(
    hermesNotificationReport({ sessionId: "acp-1", kind: "process_exit", text: "x" }).kind,
    "command",
  );
  assert.equal(
    hermesNotificationReport({ sessionId: "acp-1", kind: "watch_match", text: "x" }).kind,
    "monitor",
  );
});
