/**
 * Hermes reports auto-compaction only as status lines, which its ACP gateway
 * sends as plain assistant chunks (`acp_adapter/gateway_reply.py`). Rewritten
 * as ACP `compaction_update`s, they become the compaction row instead of reply
 * text. The wording comes from Hermes's `agent/conversation_compression.py`.
 */
import type * as EffectAcpSchema from "effect-acp/compat";

const PROGRESS =
  /^(?:🗜️? (?:Compacting context|Context too large|Compressed |Context reduced to )|📦 (?:Pre-API|Preflight) compression: |💤 Resumed after \d+s idle — compacting )/u;
/** Notices worth keeping, shown as the row's detail. */
const NOTICE = /^⚠️?\s+((?:Skipping concurrent compression|Session compressed \d+ times) .*)$/u;
const DONE = /^✓ Context compaction complete — continuing turn\.\.\.$/u;

/** `idPrefix` must differ per process: a resumed session keeps its thread's earlier rows. */
export function makeHermesCompactionTransform(idPrefix: string) {
  let count = 0;
  const open = new Map<string, { readonly id: string; readonly notice: string | undefined }>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification => {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      return notification;
    }
    const line = update.content.text.trim();
    const done = DONE.test(line);
    const notice = NOTICE.exec(line)?.[1];
    if (line.includes("\n") || (!done && notice === undefined && !PROGRESS.test(line))) {
      return notification;
    }
    const current = open.get(notification.sessionId) ?? {
      id: `${idPrefix}:${++count}`,
      notice: undefined,
    };
    const next = { id: current.id, notice: notice ?? current.notice };
    if (done) open.delete(notification.sessionId);
    else open.set(notification.sessionId, next);
    return {
      sessionId: notification.sessionId,
      ...(notification._meta === undefined ? {} : { _meta: notification._meta }),
      update: {
        sessionUpdate: "compaction_update",
        compactionId: next.id,
        status: done ? "completed" : "in_progress",
        ...(next.notice === undefined ? {} : { summary: [{ type: "text", text: next.notice }] }),
      },
    };
  };
}
