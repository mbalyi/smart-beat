import { useEffect, useState, type RefObject } from "react";

import { sameSpans, type BarSpan } from "@/lib/audio-lanes/bar-bounds";
import type { ScorePlayer } from "@/lib/score/player";

/**
 * Where the score draws each bar (continuous layout), for the lanes under the tabs: read again
 * after every draw of the notation (edits, zoom, layout, window size). Null while `enabled` is
 * false, before the first draw, and in the page layout. `epoch` changes with each new player.
 */
export function useScoreBarBounds(
  playerRef: RefObject<ScorePlayer | null>,
  epoch: number,
  enabled: boolean,
): BarSpan[] | null {
  const [spans, setSpans] = useState<BarSpan[] | null>(null);
  useEffect(() => {
    const player = playerRef.current;
    const read = () => {
      const next = enabled ? (player?.barBounds() ?? null) : null;
      // A draw that moved nothing keeps the same spans, so the lanes are not laid out again.
      setSpans((previous) => (sameSpans(previous, next) ? previous : next));
    };
    read();
    return enabled && player ? player.onLayoutChange(read) : undefined;
  }, [playerRef, epoch, enabled]);
  return spans;
}
