import { useEffect, type RefObject } from "react";

import { usePlayheadBar, type PlayheadStore } from "@/lib/score/playhead";

/**
 * A thin line that follows playback across a lane laid out one bar per `barWidth` pixels. Put it in a
 * `relative` box that starts at the first bar. `scroller` is scrolled to keep the line in view while
 * playing.
 */
export function Playhead({
  store,
  barWidth,
  playing,
  scroller,
}: {
  store: PlayheadStore;
  /** Pixels per bar (including any gap). */
  barWidth: number;
  playing: boolean;
  /** The box that scrolls sideways, when the lane is wider than it. */
  scroller?: RefObject<HTMLElement | null>;
}) {
  const bar = usePlayheadBar(store);
  const x = bar * barWidth;
  useEffect(() => {
    const el = scroller?.current;
    if (!playing || !el) return;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 8) {
      el.scrollTo?.({ left: Math.max(0, x - el.clientWidth / 4) });
    }
  }, [playing, scroller, x]);
  // Stopped at the very start (alphaTab reports a tick or two there): nothing to show yet.
  if (!playing && bar < 0.01) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="playhead"
      className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-foreground shadow-[0_0_0_1px_var(--background)]"
      style={{ left: x }}
    />
  );
}
