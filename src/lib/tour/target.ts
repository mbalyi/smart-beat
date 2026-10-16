/**
 * Whether an element can be seen and used: it takes up room, and neither it nor an ancestor is
 * inert or hidden. An open song that is not the shown one stays mounted in an inert, invisible
 * container, with all its controls.
 */
export function isShown(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  if (el.closest("[inert], [hidden]")) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/** The control a tour step points at: the one that is on screen (the shown song's), if any. */
export function findTourTarget(name: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const el of all) if (isShown(el)) return el;
  return null;
}
