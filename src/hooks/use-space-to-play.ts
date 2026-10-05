import { useEffect, useEffectEvent } from "react";

/** Where Space types a space (or picks from an open list): it never plays there. */
const TEXT_ENTRY = [
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role=textbox]",
  "[role=menu]",
  "[role=listbox]",
  "[role=dialog]",
  "[role=alertdialog]",
].join(",");
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
  "reset",
  "submit",
]);

export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(TEXT_ENTRY) !== null) return true;
  return target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type);
}

const dialogOpen = () => document.querySelector("[role=dialog], [role=alertdialog]") !== null;

/**
 * Space plays and pauses, as in Guitar Pro, wherever focus is on the page:
 * also on buttons, toggles and sliders (they do not keep Space for
 * themselves). It leaves Space alone in text fields and while a dialog or
 * menu is open.
 */
export function useSpaceToPlay(onToggle: () => void, enabled = true): void {
  const toggle = useEffectEvent(onToggle);

  useEffect(() => {
    if (!enabled) return;
    const handles = (event: KeyboardEvent) =>
      event.key === " " &&
      !event.defaultPrevented &&
      !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
      !isInteractiveTarget(event.target) &&
      !dialogOpen();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!handles(event)) return;
      event.preventDefault(); // don't scroll the page or press the focused button
      if (!event.repeat) toggle();
    };
    // A focused button presses itself when Space is released: stop that too.
    const onKeyUp = (event: KeyboardEvent) => {
      if (handles(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled]);
}
