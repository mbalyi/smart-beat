import { useEffect, useRef } from "react";

import { updateMenuState, type MenuState, type NoteEffectFlags } from "@/lib/tauri";

/** No note effects (or no note at the cursor). */
export const NO_NOTE_EFFECTS: NoteEffectFlags = {
  hammerPull: false,
  slide: false,
  vibrato: false,
  palmMute: false,
  letRing: false,
  deadNote: false,
  ghostNote: false,
  harmonic: false,
  accent: false,
  staccato: false,
};

/** What the menu shows while no song is open. */
export const NO_SONG_MENU: MenuState = {
  songOpen: false,
  undo: null,
  redo: null,
  canRemoveTrack: false,
  editMode: false,
  fretboard: false,
  loop: false,
  metronome: false,
  countIn: false,
  repeatStart: false,
  repeatEnd: false,
  hasNote: false,
  noteEffects: NO_NOTE_EFFECTS,
};

/** The component whose state the menu shows now (another tab's state must not reset it). */
let owner: object | null = null;

/**
 * Keeps the native menu bar in step with `state` (labels, check marks,
 * enabled items) while `enabled` (the song's tab is shown), and resets it when
 * the component unmounts (song closed).
 */
export function useMenuState(state: MenuState, enabled = true): void {
  const sent = useRef<string | null>(null);
  const self = useRef({});
  const json = JSON.stringify(state);

  useEffect(() => {
    if (!enabled) {
      sent.current = null; // send again when the tab is shown
      return;
    }
    if (json === sent.current) return;
    sent.current = json;
    owner = self.current;
    updateMenuState(JSON.parse(json) as MenuState).catch((error: unknown) => {
      console.warn("Could not update the menu", error);
    });
  }, [json, enabled]);

  useEffect(() => {
    const mine = self.current;
    return () => {
      sent.current = null;
      if (owner !== mine) return;
      owner = null;
      updateMenuState(NO_SONG_MENU).catch(() => {});
    };
  }, []);
}
