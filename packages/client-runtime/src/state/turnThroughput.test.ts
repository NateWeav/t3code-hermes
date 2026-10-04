import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { observeTurnThroughputItem, readTurnThroughput } from "./turnThroughput.ts";

let refCounter = 0;
function freshRef() {
  refCounter += 1;
  return {
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make(`thread-${refCounter}`),
  };
}

const run = RunId.make("run-1");
const at = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");

function baseFields(threadId: ThreadId, id: string, runId: RunId) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "running",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  } as const;
}

function text(
  threadId: ThreadId,
  chars: number,
  options: {
    readonly type?: "assistant_message" | "reasoning";
    readonly id?: string;
    readonly runId?: RunId;
    readonly streaming?: boolean;
  } = {},
): OrchestrationV2TurnItem {
  const base = baseFields(threadId, options.id ?? "item-1", options.runId ?? run);
  const body = "x".repeat(chars);
  const streaming = options.streaming ?? true;
  return options.type === "reasoning"
    ? { ...base, type: "reasoning", text: body, streaming }
    : {
        ...base,
        type: "assistant_message",
        messageId: MessageId.make("message-1"),
        text: body,
        streaming,
      };
}

function command(threadId: ThreadId): OrchestrationV2TurnItem {
  return { ...baseFields(threadId, "command-1", run), type: "command_execution", input: "ls" };
}

/** Feeds a sequence of item states the way the projection would see them. */
function feeder(ref: ReturnType<typeof freshRef>) {
  const known = new Map<string, OrchestrationV2TurnItem>();
  return (item: OrchestrationV2TurnItem, nowMs: number) => {
    observeTurnThroughputItem(ref, item, known.get(item.id), nowMs);
    known.set(item.id, item);
  };
}

describe("turnThroughput", () => {
  it("charges a flush's new text with the time since the previous flush", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 400), 0);
    expect(readTurnThroughput(ref, run, 0)?.tokensPerSecond).toBeNull();

    // 400 new chars at 4 chars/token over one second.
    feed(text(ref.threadId, 800), 1_000);
    expect(readTurnThroughput(ref, run, 1_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("averages tokens over charged time across the window", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100), 0);
    feed(text(ref.threadId, 500), 1_000);
    feed(text(ref.threadId, 1_700), 2_000);
    const throughput = readTurnThroughput(ref, run, 2_000);
    // (100 + 300 tokens) over 2 s.
    expect(throughput?.tokensPerSecond).toBeCloseTo(200);
    expect(throughput?.history).toEqual([100, 200]);
  });

  it("reads the same rate when two flushes are delivered bunched together", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100), 0);
    // The transport held one flush back and delivered both 2.9 s and 3 s in.
    feed(text(ref.threadId, 700), 2_900);
    feed(text(ref.threadId, 1_300), 3_000);
    expect(readTurnThroughput(ref, run, 3_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("counts reasoning items and the final chunk that closes a stream", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100, { type: "reasoning", id: "reasoning-1" }), 0);
    feed(text(ref.threadId, 500, { type: "reasoning", id: "reasoning-1" }), 1_000);
    feed(
      text(ref.threadId, 900, { type: "reasoning", id: "reasoning-1", streaming: false }),
      2_000,
    );
    expect(readTurnThroughput(ref, run, 2_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("ignores a message that arrives whole without streaming", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100), 0);
    feed(text(ref.threadId, 400, { id: "item-2", streaming: false }), 1_000);
    expect(readTurnThroughput(ref, run, 1_000)?.tokensPerSecond).toBeNull();
  });

  it("only counts text the client had not seen, so a thread opened mid-stream does not spike", () => {
    const ref = freshRef();
    // The item held 4,000 chars before this client last saw it; the update adds 400.
    observeTurnThroughputItem(ref, text(ref.threadId, 4_000), undefined, 0);
    observeTurnThroughputItem(ref, text(ref.threadId, 4_400), text(ref.threadId, 4_000), 1_000);
    expect(readTurnThroughput(ref, run, 1_000)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("does not charge a flush with time the model spent in a tool call", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100), 0);
    feed(command(ref.threadId), 500);
    // The tool ran for 30 s; the next paragraph took one second after it.
    feed(command(ref.threadId), 30_500);
    feed(text(ref.threadId, 400, { id: "item-2" }), 31_500);
    expect(readTurnThroughput(ref, run, 31_500)?.tokensPerSecond).toBeCloseTo(100);
  });

  it("skips replay bursts that arrive faster than any provider flushes", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100), 0);
    feed(text(ref.threadId, 4_000), 10);
    expect(readTurnThroughput(ref, run, 10)?.tokensPerSecond).toBeNull();
  });

  it("reads a null rate once the window has emptied, and nothing before the first text", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    expect(readTurnThroughput(ref, run, 0)).toBeNull();
    feed(text(ref.threadId, 100), 0);
    feed(text(ref.threadId, 500), 1_000);
    expect(readTurnThroughput(ref, run, 5_000)?.tokensPerSecond).toBeCloseTo(100);
    const quiet = readTurnThroughput(ref, run, 20_000);
    expect(quiet?.tokensPerSecond).toBeNull();
    expect(quiet?.history).toEqual([100]);
  });

  it("starts over for a new run and reads nothing for another run", () => {
    const ref = freshRef();
    const feed = feeder(ref);
    feed(text(ref.threadId, 100), 0);
    feed(text(ref.threadId, 500), 1_000);
    const nextRun = RunId.make("run-2");
    expect(readTurnThroughput(ref, nextRun, 1_000)).toBeNull();
    feed(text(ref.threadId, 100, { id: "item-2", runId: nextRun }), 60_000);
    expect(readTurnThroughput(ref, run, 60_000)).toBeNull();
    expect(readTurnThroughput(ref, nextRun, 60_000)?.history).toHaveLength(0);
  });
});
