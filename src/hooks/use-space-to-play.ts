import { useEffect, useEffectEvent } from "react";

/** Elements where Space already means something (activate, type, toggle…). */
const INTERACTIVE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role=button]",
  "[role=checkbox]",
  "[role=combobox]",
  "[role=link]",
  "[role=menuitem]",
  "[role=option]",
  "[role=radio]",
  "[role=slider]",
  "[role=switch]",
  "[role=tab]",
].join(",");

export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) !== null;
}

/**
 * Space plays and pauses, as in Guitar Pro, but only when focus is not on a
 * control, so it never takes Space away from buttons or text fields.
 */
export function useSpaceToPlay(onToggle: () => void, enabled = true): void {
  const toggle = useEffectEvent(onToggle);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault(); // don't scroll the page
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
