/** Re-sent receipt ids are remembered this long, per session. */
const SEEN_LIMIT = 1024;

/**
 * Receipt ids an agent attaches to a wake notice, for agents that settle a
 * finished result only once a prompt hands its ids back (Hermes
 * `notificationIds`). A wake becomes a queued app message whose run prompts
 * with the notice text, so ids wait here, matched by that text, until the
 * wake turn prompts.
 *
 * `admit` drops a re-sent notice while its ids are queued, prompting, or were
 * handed back by a prompt that finished. `forget` reopens ids whose prompt
 * did not finish, so the agent's redelivery wakes the session again.
 */
export class AcpWakeReceipts {
  private readonly seen = new Set<string>();
  private readonly pending: Array<{ readonly text: string; readonly ids: ReadonlyArray<string> }> =
    [];

  /** False when every id was already admitted: the notice is a re-send. */
  admit(text: string, ids: ReadonlyArray<string>): boolean {
    if (ids.length === 0) return true;
    if (ids.every((id) => this.seen.has(id))) return false;
    for (const id of ids) this.seen.add(id);
    while (this.seen.size > SEEN_LIMIT) {
      this.seen.delete(this.seen.values().next().value!);
    }
    this.pending.push({ text, ids });
    return true;
  }

  /**
   * Ids for a wake turn prompted with `promptText`. A context handoff or
   * restart note can prefix the notice, so the notice only has to end it.
   */
  take(promptText: string): ReadonlyArray<string> {
    const index = this.pending.findIndex((entry) => promptText.endsWith(entry.text));
    if (index === -1) return [];
    return this.pending.splice(index, 1)[0]!.ids;
  }

  forget(ids: ReadonlyArray<string>): void {
    for (const id of ids) this.seen.delete(id);
  }
}
