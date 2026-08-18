/**
 * Tracks whether a Hermes run has landed since the Tasks panel was last open.
 *
 * Deliberately session-local and not persisted: the dot answers "did something
 * happen while I was looking elsewhere", which is a question about this sitting,
 * not about all time. Persisting it would resurrect a stale dot on every reload.
 *
 * Plain module state rather than an atom, because both clients read it through
 * their own subscription primitive and neither needs it in a graph.
 *
 * @module state/hermesCronSeen
 */

let lastSeenSeq = 0;
let latestSeq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Called with the subscription's completion counter as runs land. */
export function reportHermesCompletionSeq(seq: number): void {
  if (seq === latestSeq) return;
  latestSeq = seq;
  emit();
}

/** Opening the panel acknowledges everything seen so far. */
export function markHermesTasksSeen(): void {
  if (lastSeenSeq === latestSeq) return;
  lastSeenSeq = latestSeq;
  emit();
}

export function subscribeHermesTasksSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasUnseenHermesCompletions(): boolean {
  return latestSeq > lastSeenSeq;
}

/** Test-only: the counters outlive a single test otherwise. */
export function resetHermesTasksSeenForTests(): void {
  lastSeenSeq = 0;
  latestSeq = 0;
  listeners.clear();
}
