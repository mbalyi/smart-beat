import { useEffect, useState, useSyncExternalStore } from "react";

import type { StemPlayer, StemPlayerState } from "@/lib/stems/player";

/** The player's state; the page renders again after every change. */
export function useStemState(player: StemPlayer): StemPlayerState {
  return useSyncExternalStore(player.subscribe, () => player.state);
}

/**
 * Seconds into the song. While it plays the clock is read about 15 times a second; otherwise it
 * only moves when the player changes (a seek, a pause).
 */
export function usePosition(player: StemPlayer): number {
  const { playing } = useStemState(player);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTick((tick) => tick + 1), 66);
    return () => clearInterval(id);
  }, [playing]);
  return player.position();
}
