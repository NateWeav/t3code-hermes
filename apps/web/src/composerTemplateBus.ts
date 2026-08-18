/**
 * Hands a prompt template to the composer from a route that does not have one.
 *
 * Full-page views like Hermes Tasks live outside the chat layout, so the
 * composer is unmounted while they are open and there is no ref to call. This
 * holds one pending template until a composer appears and claims it, which is
 * why it is a slot rather than an event: the request is made before the
 * listener exists.
 *
 * Only the most recent request survives — pressing "New task…" twice should
 * prefill once, not queue two.
 */
const TEMPLATE_READY_EVENT = "t3code:composer-template-ready";

let pendingTemplate: string | null = null;

/** Queues a template and wakes any composer that is already mounted. */
export function requestComposerTemplate(template: string): void {
  pendingTemplate = template;
  window.dispatchEvent(new CustomEvent(TEMPLATE_READY_EVENT));
}

/**
 * Takes the pending template, if any. Claiming it clears the slot so a
 * remount does not prefill the composer a second time.
 */
export function claimComposerTemplate(): string | null {
  const template = pendingTemplate;
  pendingTemplate = null;
  return template;
}

export function onComposerTemplateRequested(listener: () => void): () => void {
  window.addEventListener(TEMPLATE_READY_EVENT, listener);
  return () => window.removeEventListener(TEMPLATE_READY_EVENT, listener);
}
