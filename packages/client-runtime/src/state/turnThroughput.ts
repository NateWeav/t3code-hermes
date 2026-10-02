/**
 * Live output-token throughput for the running turn, estimated on the client.
 *
 * No provider streams a per-token count: usage snapshots land at step
 * boundaries and assistant text reaches the client in paragraph-sized flushes
 * (see `ProviderRuntimeIngestion`). So the rate comes from the text that does
 * stream. Each flush is charged with the time since the previous flush, or
 * since the last tool activity when the model was busy elsewhere, and the
 * displayed rate is total tokens over total charged time across a short
 * window. Summing spans rather than rating flushes one by one keeps a pair
 * of deliveries bunched by the transport from reading as a spike, and a long
 * code block held back by the paragraph buffer spreads over the time it
 * actually took. Tokens are chars ÷ 4; usage snapshots cannot calibrate that
 * because hidden output (summarized thinking, tool-call JSON) never streams.
 *
 * Plain module state rather than an atom, like hermesCronSeen: the readers are
 * self-ticking labels that poll once a second, so nothing subscribes.
 *
 * @module state/turnThroughput
 */
import type { OrchestrationEvent, ScopedThreadRef, TurnId } from "@t3tools/contracts";

import { threadKey } from "./entities.ts";

export interface TurnThroughput {
  /** Tokens per second over the recent window, or null once no text has arrived for a while. */
  readonly tokensPerSecond: number | null;
  /** Rate after each recent flush, oldest first, for a sparkline. */
  readonly history: ReadonlyArray<number>;
}

interface FlushSample {
  readonly atMs: number;
  readonly tokens: number;
  /** Generation time charged to this flush; null for the first flush after a gap. */
  readonly spanMs: number | null;
}

interface ThreadThroughputState {
  turnId: TurnId;
  /** When the model last demonstrably started or continued generating. */
  referenceAtMs: number | null;
  samples: FlushSample[];
  history: number[];
}

const CHARS_PER_TOKEN = 4;
/** How much recent generation the displayed rate averages over. */
const WINDOW_MS = 8_000;
/** Flushes closer than this are a replay burst or one delivery split in two; they carry no time. */
const MIN_SPAN_MS = 50;
export const TURN_THROUGHPUT_HISTORY_LENGTH = 24;
const MAX_TRACKED_THREADS = 64;

const stateByThread = new Map<string, ThreadThroughputState>();

function stateFor(key: string, turnId: TurnId): ThreadThroughputState {
  const existing = stateByThread.get(key);
  if (existing?.turnId === turnId) return existing;
  if (existing === undefined && stateByThread.size >= MAX_TRACKED_THREADS) {
    const oldest = stateByThread.keys().next().value;
    if (oldest !== undefined) stateByThread.delete(oldest);
  }
  const next: ThreadThroughputState = { turnId, referenceAtMs: null, samples: [], history: [] };
  stateByThread.set(key, next);
  return next;
}

function windowRate(samples: ReadonlyArray<FlushSample>, nowMs: number): number | null {
  let tokens = 0;
  let spanMs = 0;
  for (const sample of samples) {
    if (sample.spanMs === null || nowMs - sample.atMs > WINDOW_MS) continue;
    tokens += sample.tokens;
    spanMs += sample.spanMs;
  }
  return spanMs > 0 ? (tokens / spanMs) * 1000 : null;
}

function observeText(state: ThreadThroughputState, chars: number, nowMs: number): void {
  const reference = state.referenceAtMs;
  state.referenceAtMs = nowMs;
  const spanMs = reference !== null && nowMs - reference >= MIN_SPAN_MS ? nowMs - reference : null;
  state.samples = state.samples.filter((sample) => nowMs - sample.atMs <= WINDOW_MS);
  state.samples.push({ atMs: nowMs, tokens: chars / CHARS_PER_TOKEN, spanMs });
  const rate = windowRate(state.samples, nowMs);
  if (rate === null) return;
  state.history.push(rate);
  if (state.history.length > TURN_THROUGHPUT_HISTORY_LENGTH) state.history.shift();
}

/**
 * Feed one live thread event. Replayed history must not come through here:
 * its timing is the replay's, not the model's.
 */
export function observeTurnThroughputEvent(
  ref: ScopedThreadRef,
  event: OrchestrationEvent,
  nowMs: number,
): void {
  if (event.type === "thread.message-sent") {
    const message = event.payload;
    if (!message.streaming || message.turnId === null) return;
    if (message.role !== "assistant" && message.role !== "reasoning") return;
    observeText(stateFor(threadKey(ref), message.turnId), message.text.length, nowMs);
    return;
  }
  if (event.type === "thread.activity-appended") {
    const activity = event.payload.activity;
    // Usage snapshots land beside the text they describe; anything else means
    // the model was running a tool, not generating, until now.
    if (activity.turnId === null || activity.kind === "context-window.updated") return;
    stateFor(threadKey(ref), activity.turnId).referenceAtMs = nowMs;
  }
}

/**
 * The current turn's throughput, or null when the turn has produced no text
 * yet. A turn that produced text but has gone quiet reads as a null rate with
 * its history intact.
 */
export function readTurnThroughput(
  ref: ScopedThreadRef,
  turnId: TurnId,
  nowMs: number,
): TurnThroughput | null {
  const state = stateByThread.get(threadKey(ref));
  if (state === undefined || state.turnId !== turnId || state.samples.length === 0) return null;
  return { tokensPerSecond: windowRate(state.samples, nowMs), history: state.history };
}
