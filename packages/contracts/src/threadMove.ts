import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const ThreadMoveState = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  direction: Schema.Literals(["outgoing", "incoming"]),
  phase: Schema.Literals(["preparing", "committed", "complete"]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  label: Schema.String,
  startedAt: IsoDateTime,
  modelSelection: ModelSelection,
  resumeAtReset: Schema.Boolean,
  resetAt: Schema.NullOr(IsoDateTime),
  automatic: Schema.optionalKey(Schema.Boolean),
  /** The source stopped a running turn for this move; the thread continues where it lands. */
  resume: Schema.optionalKey(Schema.Boolean),
});
export type ThreadMoveState = typeof ThreadMoveState.Type;

export const ThreadMoveInput = Schema.Struct({
  threadId: ThreadId,
  destinationEnvironmentId: EnvironmentId,
  modelSelection: Schema.optional(ModelSelection),
  resumeAtReset: Schema.Boolean,
});
export type ThreadMoveInput = typeof ThreadMoveInput.Type;

export const ThreadMoveResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  label: Schema.String,
  link: TrimmedNonEmptyString,
});
export type ThreadMoveResult = typeof ThreadMoveResult.Type;

export const ThreadMoveModels = Schema.Array(
  Schema.Struct({
    selection: ModelSelection,
    label: Schema.String,
  }),
);
export type ThreadMoveModels = typeof ThreadMoveModels.Type;

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  reason: Schema.Literals([
    "busy",
    "unsupported",
    "destination",
    "transfer",
    "committed",
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "busy":
        return "The thread is still busy. Send or remove its queued messages and stop watching its pull requests, then try again.";
      case "unsupported":
        return "This thread cannot be moved. Use an unarchived, top-level conversation in a Git checkout.";
      case "destination":
        return "The destination needs a full-access environment link and the selected provider and model. Check Connections and provider settings on both machines.";
      case "transfer":
        return "The move did not finish. Retry the move, or cancel it to keep working here.";
      case "committed":
        return "The thread has been handed off. Retry to finish activation on the destination; it cannot be resumed here.";
      case "storage":
        return "The move could not be saved. The server log has details.";
    }
  }
}
