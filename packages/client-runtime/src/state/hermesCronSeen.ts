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

type EnvironmentKey = string;
const seenByEnvironment = new Map<EnvironmentKey, { lastSeenSeq: number; latestSeq: number }>();
const listeners = new Set<() => void>();

function state(environmentId: EnvironmentKey) {
  let value = seenByEnvironment.get(environmentId);
  if (value === undefined) {
    value = { lastSeenSeq: 0, latestSeq: 0 };
    seenByEnvironment.set(environmentId, value);
  }
  return value;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Called with the subscription's completion counter as runs land. */
export function reportHermesCompletionSeq(environmentId: EnvironmentKey, seq: number): void {
  const current = state(environmentId);
  if (seq === current.latestSeq) return;
  current.latestSeq = seq;
  emit();
}

/** Opening the panel acknowledges everything seen so far. */
export function markHermesTasksSeen(environmentId: EnvironmentKey): void {
  const current = state(environmentId);
  if (current.lastSeenSeq === current.latestSeq) return;
  current.lastSeenSeq = current.latestSeq;
  emit();
}

export function subscribeHermesTasksSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasUnseenHermesCompletions(environmentId: EnvironmentKey): boolean {
  const current = state(environmentId);
  return current.latestSeq > current.lastSeenSeq;
}

/** Test-only: the counters outlive a single test otherwise. */
export function resetHermesTasksSeenForTests(): void {
  seenByEnvironment.clear();
  listeners.clear();
}
