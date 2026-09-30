import { useEffect, useRef } from "react";

import { updateMenuState, type MenuState } from "@/lib/tauri";

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
};

/**
 * Keeps the native menu bar in step with `state` (labels, check marks,
 * enabled items), and resets it when the component unmounts (song closed).
 */
export function useMenuState(state: MenuState): void {
  const sent = useRef<string | null>(null);
  const json = JSON.stringify(state);

  useEffect(() => {
    if (json === sent.current) return;
    sent.current = json;
    updateMenuState(JSON.parse(json) as MenuState).catch((error: unknown) => {
      console.warn("Could not update the menu", error);
    });
  }, [json]);

  useEffect(
    () => () => {
      sent.current = null;
      updateMenuState(NO_SONG_MENU).catch(() => {});
    },
    [],
  );
}
