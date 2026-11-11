import { useEffect, useRef, type RefObject } from "react";

/** Where the keyboard is busy: a text field, or a dialog or menu that took focus. */
const KEEPS_FOCUS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]';

/**
 * Focus that should stay where it is: inside a text field, dialog or menu that is still in use.
 * Focus on nothing, or left behind in a hidden (inert) song, can move.
 */
export function keepsFocus(element: Element | null): boolean {
  if (!element || !element.isConnected || element.closest("[inert]")) return false;
  return element.closest(KEEPS_FOCUS) !== null;
}

/**
 * When a song's tab is shown again in edit mode, puts the keyboard back in its score, so the
 * arrows and note entry go on from the edit cursor without a click (#228). The cursor and
 * selection live in the song's editor, which stays mounted while the tab is hidden; only the
 * focus is lost, because the tab that was clicked sits in the song being left (now inert).
 *
 * Runs only when `active` turns on, never on mount or while the tab stays shown, and leaves a
 * text field, dialog or menu that has focus alone.
 */
export function useRestoreEditFocus(
  target: RefObject<HTMLElement | null>,
  { active, editing }: { active: boolean; editing: boolean },
): void {
  const wasActive = useRef(active);

  useEffect(() => {
    const activated = active && !wasActive.current;
    wasActive.current = active;
    if (!activated || !editing) return;
    // After the frame: the song being left is inert by then and a dialog has taken focus.
    const frame = requestAnimationFrame(() => {
      const element = target.current;
      if (!element?.isConnected || keepsFocus(document.activeElement)) return;
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, editing, target]);
}
