import {
  ChatAttachment,
  EnvironmentId,
  IsoDateTime,
  ModelSelection,
  OrchestrationV2ProviderFailure,
  OrchestrationV2TurnItem,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { WorkspaceSnapshot } from "./WorkspaceTransfer.ts";

export const MoveId = Schema.String.check(Schema.isUUID());
export const MoveHeader = Schema.Struct({
  id: MoveId,
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: Schema.String,
  sourceThreadId: ThreadId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  projectTitle: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  resumeAtReset: Schema.Boolean,
  resume: Schema.optionalKey(Schema.Boolean),
});
export type MoveHeader = typeof MoveHeader.Type;

export const MoveHistory = Schema.Struct({
  snapshot: WorkspaceSnapshot,
  items: Schema.Array(OrchestrationV2TurnItem),
  attachments: Schema.Array(ChatAttachment),
  limit: Schema.NullOr(
    Schema.Struct({
      failure: OrchestrationV2ProviderFailure,
      completedAt: IsoDateTime,
    }),
  ),
});
export type MoveHistory = typeof MoveHistory.Type;

export const StoredMove = Schema.Struct({
  owner: Schema.String,
  header: MoveHeader,
  ready: Schema.Boolean,
});
export type StoredMove = typeof StoredMove.Type;

export const MOVE_ROUTE = "/mcp/thread-moves";
export const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const moveThreadId = (id: string) => ThreadId.make(`moved-${id}`);
