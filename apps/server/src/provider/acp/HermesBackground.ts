/**
 * Hermes background work over ACP. Only the carried `acp-background-reports`
 * patch (infra/hermes) sends `_hermes/process` and `_hermes/notification`;
 * stock Hermes reports nothing once a background terminal call returns, so
 * without the patch no task is ever opened and none can be left running.
 */
import * as Schema from "effect/Schema";

import type {
  BackgroundWork,
  BackgroundWorkReport,
} from "@t3tools/provider-core/server/notification";

export const HERMES_PROCESS_METHOD = "_hermes/process";

/** A background process a `terminal` call left running, then its exit. */
export const HermesProcessReport = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  processId: Schema.String,
  command: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  reason: Schema.optional(Schema.String),
});
export type HermesProcessReport = typeof HermesProcessReport.Type;

export const HERMES_NOTIFICATION_METHOD = "_hermes/notification";

/**
 * Text Hermes's CLI would inject as the next turn when background work
 * finishes (a process exit, a watch match, a subagent result). Hermes sends it
 * only while the session is idle.
 */
export const HermesNotification = Schema.Struct({
  sessionId: Schema.String,
  kind: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.String,
  /** Receipts for the durable results the notice reports (receipts patch). */
  notificationIds: Schema.optional(Schema.Array(Schema.String)),
});
export type HermesNotification = typeof HermesNotification.Type;

/** A process report as a background-task mutation, keyed by Hermes's process id. */
export function hermesProcessMutation(report: HermesProcessReport) {
  const label = report.command.trim().split("\n")[0]!.slice(0, 200) || "Background process";
  // A kill is the user's or the agent's choice, not a failure.
  const succeeded =
    report.reason === "killed" ||
    (report.reason !== "lost" && report.reason !== "failed_start" && report.exitCode === 0);
  const status =
    report.status === "running"
      ? ("running" as const)
      : succeeded
        ? ("completed" as const)
        : ("failed" as const);
  return {
    sessionId: report.sessionId,
    taskId: report.processId,
    status,
    report: {
      kind: "command",
      label,
      ...(typeof report.exitCode === "number" ? { exitCode: report.exitCode } : {}),
    } satisfies BackgroundWork,
  };
}

/** Names the background work a Hermes notice wakes the agent about. */
export function hermesNotificationReport(notice: HermesNotification): BackgroundWorkReport {
  const kind = notice.kind.toLowerCase();
  const label = notice.title?.trim() || undefined;
  if (kind.includes("subagent") || kind.includes("delegat")) {
    return { kind: "subagent", label, outcome: "completed" };
  }
  if (kind.includes("watch")) return { kind: "monitor", label, outcome: "updated" };
  if (kind.includes("process")) return { kind: "command", label, outcome: "completed" };
  return { kind: "background_task", label, outcome: "updated" };
}
