import { useEffect, useEffectEvent, type RefObject } from "react";

import type { ScoreEditor } from "@/lib/score/editor";
import type { NoteEffectId } from "@/lib/score/effects";

/** ⌘ on macOS, Ctrl elsewhere. */
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface EditorKeyOptions {
  enabled: boolean;
  /**
   * In the desktop app, Undo and Redo come from the native Edit menu (its
   * accelerators reach the menu, not the page), so the keys are left alone to
   * avoid undoing twice.
   */
  menuHandlesUndo: boolean;
  /** Shift+B: opens the bend editor. */
  onBend?: () => void;
}

/** Plain keys that switch a note effect on or off (as in Guitar Pro where it can). */
const EFFECT_KEYS: Record<string, NoteEffectId> = {
  h: "hammerPull",
  s: "slideOut",
  p: "palmMute",
  l: "letRing",
  x: "dead",
  o: "ghost",
  w: "vibrato",
  n: "harmonic",
  ">": "accent",
};

/**
 * Keyboard entry in the score (while it has focus), modelled on Guitar Pro:
 * arrows move, digits type frets, A–G type pitches, + and − change the note
 * value, and so on. See `EDITOR_SHORTCUTS` for the list shown to users.
 */
export function useEditorKeys(
  target: RefObject<HTMLElement | null>,
  editor: ScoreEditor,
  { enabled, menuHandlesUndo, onBend }: EditorKeyOptions,
): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const key = event.key;
    const handled = (): true => {
      event.preventDefault();
      return true;
    };

    if (mod && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === "c") return handled() && editor.copy();
      if (lower === "x") return handled() && editor.cut();
      if (lower === "v") return handled() && editor.paste();
      if (lower === "a") return handled() && editor.selectAll();
      if (!menuHandlesUndo && lower === "z") {
        handled();
        return event.shiftKey ? editor.redo() : editor.undo();
      }
      if (!menuHandlesUndo && lower === "y" && !isMac()) return handled() && editor.redo();
      if (key === "ArrowLeft") return handled() && editor.moveBar(-1, event.shiftKey);
      if (key === "ArrowRight") return handled() && editor.moveBar(1, event.shiftKey);
      return;
    }

    switch (key) {
      case "ArrowLeft":
      case "ArrowRight":
        if (event.altKey) return;
        handled();
        editor.moveBeat(key === "ArrowLeft" ? -1 : 1, event.shiftKey);
        return;
      case "ArrowUp":
      case "ArrowDown":
        handled();
        if (event.altKey) editor.transpose(key === "ArrowUp" ? 1 : -1);
        else editor.moveString(key === "ArrowUp" ? 1 : -1);
        return;
      case "Backspace":
      case "Delete":
        handled();
        if (event.shiftKey) editor.deleteBeats();
        else editor.deleteAtCursor();
        return;
      case "Insert":
        handled();
        editor.insertBeat();
        return;
      case "Escape":
        if (editor.selection) {
          handled();
          editor.clearSelection();
        }
        return;
    }

    if (!plain) return;
    if (/^[0-9]$/.test(key)) {
      handled();
      editor.typeDigit(Number(key));
      return;
    }
    const lower = key.toLowerCase();
    if (/^[a-g]$/.test(lower) && !event.shiftKey) {
      handled();
      editor.enterLetter(lower);
      return;
    }
    if (key === "B" && event.shiftKey && onBend) {
      handled();
      onBend();
      return;
    }
    const effect = EFFECT_KEYS[key] ?? EFFECT_KEYS[lower];
    if (effect) {
      handled();
      editor.toggleNoteEffect(effect);
      return;
    }
    switch (key) {
      case "+":
      case "=":
        handled();
        editor.stepDuration(1);
        return;
      case "-":
        handled();
        editor.stepDuration(-1);
        return;
      case ".":
        handled();
        editor.toggleDots(1);
        return;
      case "r":
      case "R":
        handled();
        editor.clearNotes();
        return;
      case "i":
      case "I":
        handled();
        editor.insertBeat();
        return;
      case "t":
      case "T":
        handled();
        editor.toggleTie();
        return;
      case "v":
      case "V":
        handled();
        editor.switchVoice(editor.cursor.voice === 0 ? 1 : 0);
        return;
    }
  });

  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    element.addEventListener("keydown", listener);
    return () => element.removeEventListener("keydown", listener);
  }, [enabled, target]);
}

/**
 * The editor's keys, for the Keyboard Shortcuts dialog. `mod` is ⌘ or Ctrl;
 * `spoken` is what screen readers hear instead of the key caps.
 */
export const EDITOR_SHORTCUTS: { keys: string[]; spoken: string; label: string }[] = [
  {
    keys: ["←", "→"],
    spoken: "Left or Right arrow",
    label: "Previous / next beat (adds beats and bars at the end)",
  },
  {
    keys: ["↑", "↓"],
    spoken: "Up or Down arrow",
    label: "Higher / lower string (tab), or note of a chord",
  },
  { keys: ["mod", "←/→"], spoken: "mod+Left or Right arrow", label: "Previous / next bar" },
  { keys: ["⇧", "arrows"], spoken: "Shift+arrows", label: "Select beats" },
  { keys: ["0–9"], spoken: "0 to 9", label: "Type a fret (two quick digits: 10–29)" },
  { keys: ["A–G"], spoken: "A to G", label: "Type a pitch (nearest octave)" },
  { keys: ["⌥", "↑/↓"], spoken: "Option+Up or Down arrow", label: "Note a semitone up / down" },
  { keys: ["+", "−"], spoken: "Plus or Minus", label: "Shorter / longer note value" },
  { keys: ["."], spoken: "Period", label: "Dotted note" },
  { keys: ["R"], spoken: "R", label: "Make a rest" },
  { keys: ["T"], spoken: "T", label: "Tie to the previous note" },
  { keys: ["V"], spoken: "V", label: "Switch between voice 1 and 2" },
  { keys: ["I"], spoken: "I", label: "Insert a beat" },
  { keys: ["H"], spoken: "H", label: "Hammer-on / pull-off" },
  { keys: ["S"], spoken: "S", label: "Slide to the next note" },
  { keys: ["P"], spoken: "P", label: "Palm mute" },
  { keys: ["L"], spoken: "L", label: "Let ring" },
  { keys: ["X"], spoken: "X", label: "Dead note" },
  { keys: ["O"], spoken: "O", label: "Ghost note" },
  { keys: ["W"], spoken: "W", label: "Vibrato" },
  { keys: ["N"], spoken: "N", label: "Natural harmonic" },
  { keys: [">"], spoken: "Greater than", label: "Accent" },
  { keys: ["⇧", "B"], spoken: "Shift+B", label: "Bend…" },
  { keys: ["Delete"], spoken: "Delete", label: "Delete the note (or clear the selection)" },
  { keys: ["⇧", "Delete"], spoken: "Shift+Delete", label: "Delete the beat" },
  { keys: ["mod", "C / X / V"], spoken: "mod+C, X or V", label: "Copy / cut / paste" },
  { keys: ["mod", "A"], spoken: "mod+A", label: "Select the whole track" },
  { keys: ["Space"], spoken: "Space", label: "Play / pause" },
];
