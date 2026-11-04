/**
 * Settings tells the start screen when the cloud accounts or the linked folder change, so the
 * Cloud sections there read them again instead of showing what they found when the screen opened.
 */
const EVENT = "smart-beat:cloud-changed";

/** Something about the cloud accounts or the cloud folder just changed. */
export function announceCloudChange() {
  window.dispatchEvent(new Event(EVENT));
}

/** Calls `listener` after each change; returns the function that stops listening. */
export function onCloudChange(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
