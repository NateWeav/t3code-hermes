import {
  EventId,
  MessageId,
  RunId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { attachmentFileExtension } from "../attachmentStore.ts";
import { inferImageExtension } from "../imageMime.ts";
import type { MoveHeader, MoveHistory } from "./protocol.ts";

type PortableItem = Extract<
  OrchestrationV2TurnItem,
  {
    type:
      | "user_message"
      | "assistant_message"
      | "reasoning"
      | "command_execution"
      | "file_change"
      | "file_search"
      | "web_search"
      | "system_notice"
      | "error"
      | "run_interrupt_result"
      | "compaction";
  }
>;

export function portableItem(item: OrchestrationV2TurnItem): PortableItem | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "system_notice":
    case "error":
    case "run_interrupt_result":
    case "compaction":
      return item;
    case "proposed_plan":
      return {
        id: item.id,
        threadId: item.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        providerThreadId: item.providerThreadId,
        providerTurnId: item.providerTurnId,
        nativeItemRef: item.nativeItemRef,
        parentItemId: item.parentItemId,
        ordinal: item.ordinal,
        status: item.status,
        title: item.title,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        updatedAt: item.updatedAt,
        type: "assistant_message",
        messageId: MessageId.make(item.id),
        text: item.markdown,
        streaming: false,
      };
    default:
      return null;
  }
}

export function importedMoveEvents(input: {
  header: MoveHeader;
  history: MoveHistory;
  thread: OrchestrationV2AppThread;
}): {
  events: ReadonlyArray<OrchestrationV2DomainEvent>;
  attachments: ReadonlyArray<ChatAttachment>;
} {
  const { thread, header, history } = input;
  const attachments = history.attachments.map((attachment, index) => {
    const extension =
      attachment.type === "image"
        ? inferImageExtension({ mimeType: attachment.mimeType, fileName: attachment.name })
        : attachmentFileExtension(attachment.name);
    return { ...attachment, id: `moved-${index}-${header.id}-${extension.slice(1)}` };
  });
  const byId = new Map(
    history.attachments.map((attachment, index) => [attachment.id, attachments[index]!]),
  );
  const events: Array<OrchestrationV2DomainEvent> = [];
  let userMessageId = MessageId.make(`${thread.id}:resume`);
  const event = (payload: OrchestrationV2TurnItem) => {
    events.push({
      id: EventId.make(payload.id),
      type: "turn-item.updated",
      threadId: thread.id,
      occurredAt: payload.updatedAt,
      payload,
    });
  };
  history.items.forEach((raw, index) => {
    const source = portableItem(raw);
    if (source === null) return;
    const id = TurnItemId.make(`${thread.id}:history:${index}`);
    const messageId = MessageId.make(id);
    const item = {
      ...source,
      id,
      threadId: thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
    };
    if (item.type === "user_message" || item.type === "assistant_message") {
      const files = (item.attachments ?? []).map((file) => byId.get(file.id) ?? file);
      if (item.type === "user_message") userMessageId = messageId;
      events.push({
        id: EventId.make(`${id}:message`),
        type: "message.updated",
        threadId: thread.id,
        occurredAt: item.updatedAt,
        payload: {
          id: messageId,
          threadId: thread.id,
          runId: null,
          nodeId: null,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          attachments: files,
          streaming: false,
          createdBy: item.type === "user_message" ? "user" : "agent",
          creationSource: "server",
          createdAt: item.startedAt ?? item.updatedAt,
          updatedAt: item.updatedAt,
        },
      });
      if (item.type === "user_message") {
        const {
          context: _context,
          scheduledTaskId: _task,
          senderThreadId: _sender,
          workflowScript: _script,
          ...rest
        } = item;
        event({ ...rest, messageId, attachments: files, inputIntent: "turn_start" });
      } else event({ ...item, messageId, attachments: files, streaming: false });
    } else if (item.type === "reasoning") event({ ...item, streaming: false });
    else event(item);
  });
  if (history.limit !== null) {
    const completedAt = DateTime.makeUnsafe(history.limit.completedAt);
    const runId = RunId.make(`${thread.id}:limited`);
    const run: OrchestrationV2Run = {
      id: runId,
      threadId: thread.id,
      ordinal: 1,
      providerInstanceId: thread.providerInstanceId,
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "failed",
      requestedAt: completedAt,
      startedAt: completedAt,
      completedAt,
      checkpointId: null,
      contextHandoffId: null,
    };
    events.push({
      id: EventId.make(`${runId}:created`),
      type: "run.created",
      threadId: thread.id,
      occurredAt: completedAt,
      payload: run,
    });
    event({
      id: TurnItemId.make(`${runId}:error`),
      threadId: thread.id,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: history.items.length + 1,
      status: "failed",
      title: null,
      startedAt: completedAt,
      completedAt,
      updatedAt: completedAt,
      type: "error",
      failure: history.limit.failure,
    });
  }
  return { events, attachments };
}
