/**
 * Workarounds for bugs in alphaTab 1.8.4, applied at run time (alphaTab's own
 * files are not changed). Remove each one once alphaTab fixes it.
 */
import { model } from "@coderline/alphatab";

let applied = false;

/**
 * Capella import: the CapXML parser asks a new chord for its length before
 * adding it to its voice, and `Beat.isFullBarRest` then reads `voice.beats`
 * of a beat that has no voice yet, so every Capella file with a note failed
 * to open. A beat without a voice is not a full-bar rest; anything else
 * behaves as before.
 */
function guardFullBarRest() {
  const prototype = model.Beat.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "isFullBarRest");
  if (!original?.get) return;
  const get = original.get;
  Object.defineProperty(prototype, "isFullBarRest", {
    configurable: true,
    get(this: model.Beat) {
      return this.voice ? (get.call(this) as boolean) : false;
    },
  });
}

/** Applies every workaround once. */
export function applyAlphaTabFixes() {
  if (applied) return;
  applied = true;
  guardFullBarRest();
}
