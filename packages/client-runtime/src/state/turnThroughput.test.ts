import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import type { OrchestrationEvent } from "@t3tools/contracts";

import { observeTurnThroughputEvent, readTurnThroughput } from "./turnThroughput.ts";

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 1,
  occurredAt: "2026-04-01T00:00:00.000Z",
  aggregateKind: "thread",
} as const;

let refCounter = 0;
function freshRef() {
  refCounter += 1;
  return {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make(`thread-${refCounter}`),
  };
}

const turn = TurnId.make("turn-1");

function textDelta(
  threadId: ThreadId,
  chars: number,
  options: { readonly role?: "assistant" | "reasoning" | "user"; readonly turnId?: TurnId } = {},
): OrchestrationEvent {
  return {
    ...baseEventFields,
    aggregateId: threadId,
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make("message-1"),
      role: options.role ?? "assistant",
      text: "x".repeat(chars),
      turnId: options.turnId ?? turn,
      streaming: true,
      createdAt: baseEventFields.occurredAt,
      updatedAt: baseEventFields.occurredAt,
    },
  };
}

function activity(threadId: ThreadId, kind: string, payload: unknown = {}): OrchestrationEvent {
  return {
    ...baseEventFields,
    aggregateId: threadId,
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.make("activity-1"),
        tone: "tool",
        kind,
        summary: kind,
        payload,
        turnId: turn,
        createdAt: baseEventFields.occurredAt,
      },
    },
  };
}

describe("turnThroughput", () => {
  it("charges a flush with the time since the previous flush", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    expect(readTurnThroughput(ref, turn, 0)?.tokensPerSecond).toBeNull();

    // 400 chars at 4 chars/token over one second.
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400), 1_000);
    expect(readTurnThroughput(ref, turn, 1_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("averages tokens over charged time across the window", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400), 1_000);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 1_200), 2_000);
    const throughput = readTurnThroughput(ref, turn, 2_000);
    // (100 + 300 tokens) over 2 s.
    expect(throughput?.tokensPerSecond).toBeCloseTo(200);
    expect(throughput?.history).toEqual([100, 200]);
  });

  it("reads the same rate when two flushes are delivered bunched together", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    // The transport held one flush back and delivered both 2.9 s and 3 s in.
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 600), 2_900);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 600), 3_000);
    expect(readTurnThroughput(ref, turn, 3_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("counts reasoning text and ignores user and non-streaming messages", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400, { role: "user" }), 500);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400, { role: "reasoning" }), 1_000);
    expect(readTurnThroughput(ref, turn, 1_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("does not charge a flush with time the model spent in a tool call", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(ref, activity(ref.threadId, "file-edit"), 500);
    // The tool ran for 30 s; the next paragraph took one second after it.
    observeTurnThroughputEvent(ref, activity(ref.threadId, "file-edit"), 30_500);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400), 31_500);
    expect(readTurnThroughput(ref, turn, 31_500)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("lets a usage snapshot through without charging the text after it", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(
      ref,
      activity(ref.threadId, "context-window.updated", { usedTokens: 1, outputTokens: 50 }),
      900,
    );
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400), 1_000);
    expect(readTurnThroughput(ref, turn, 1_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("skips replay bursts that arrive faster than any provider flushes", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 4_000), 10);
    expect(readTurnThroughput(ref, turn, 10)?.tokensPerSecond).toBeNull();
  });

  it("reads a null rate once the window has emptied, and nothing before the first text", () => {
    const ref = freshRef();
    expect(readTurnThroughput(ref, turn, 0)).toBeNull();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400), 1_000);
    expect(readTurnThroughput(ref, turn, 5_000)?.tokensPerSecond).toBeCloseTo(100);
    const quiet = readTurnThroughput(ref, turn, 20_000);
    expect(quiet?.tokensPerSecond).toBeNull();
    expect(quiet?.history).toEqual([100]);
  });

  it("starts over for a new turn and reads nothing for another turn", () => {
    const ref = freshRef();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100), 0);
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 400), 1_000);
    const nextTurn = TurnId.make("turn-2");
    expect(readTurnThroughput(ref, nextTurn, 1_000)).toBeNull();
    observeTurnThroughputEvent(ref, textDelta(ref.threadId, 100, { turnId: nextTurn }), 60_000);
    expect(readTurnThroughput(ref, turn, 60_000)).toBeNull();
    expect(readTurnThroughput(ref, nextTurn, 60_000)?.history).toHaveLength(0);
  });
});
