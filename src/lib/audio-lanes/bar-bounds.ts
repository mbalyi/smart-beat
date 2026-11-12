import { barAtTimelineMs, timelineMsAtBar, type SongGrid } from "@/lib/audio-lanes/sync";
import type { AudioLanesSettings } from "@/lib/tauri";

/** Where a bar is drawn: its left edge and its width, in pixels from the left of the notation. */
export interface BarSpan {
  x: number;
  width: number;
}

/**
 * The audio timeline laid out on the bars as the score draws them (the lanes under the tabs). The
 * bars have different widths, so time and pixels are not proportional: inside a bar they are, and
 * the bars join the two. Both directions are monotonic. Before the first bar and after the last the
 * grid goes on at that bar's width, as the audio timeline does.
 */
export interface BarBounds {
  /** Pixels (from the notation's left edge) at an audio timeline point. */
  msToX: (ms: number) => number;
  /** The audio timeline point at pixels from the notation's left edge. */
  xToMs: (x: number) => number;
  /** Pixels at a fractional bar (0 is the start of the first bar). */
  barToX: (bar: number) => number;
  /** The fractional bar at pixels. */
  xToBar: (x: number) => number;
  /** Where the last bar ends. */
  end: number;
}

/** A width that cannot divide: a bar the notation drew without width counts as one pixel. */
const safeWidth = (span: BarSpan): number => (span.width > 0 ? span.width : 1);

/**
 * Time and pixel mappings for the bars `spans` (bar 0 first), on the lanes' sync map `audio` and
 * the song's `grid`. Null when there are no bars to map.
 */
export function createBarBounds(
  audio: AudioLanesSettings,
  grid: SongGrid,
  spans: readonly BarSpan[],
): BarBounds | null {
  const count = spans.length;
  if (count === 0) return null;
  const last = spans[count - 1]!;
  const end = last.x + safeWidth(last);

  const barToX = (bar: number): number => {
    if (!Number.isFinite(bar)) return spans[0]!.x;
    const i = Math.min(count - 1, Math.max(0, Math.floor(bar)));
    const span = spans[i]!;
    return span.x + (bar - i) * safeWidth(span);
  };

  const xToBar = (x: number): number => {
    if (!Number.isFinite(x)) return 0;
    // The last bar that starts at or before x (the first one for points before the notation).
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (spans[mid]!.x <= x) lo = mid;
      else hi = mid - 1;
    }
    const into = (x - spans[lo]!.x) / safeWidth(spans[lo]!);
    // A gap between two bars belongs to the earlier one, up to the start of the next.
    return lo + (lo < count - 1 ? Math.min(1, into) : into);
  };

  return {
    msToX: (ms) => barToX(barAtTimelineMs(audio, grid, ms)),
    xToMs: (x) => timelineMsAtBar(audio, grid, xToBar(x)),
    barToX,
    xToBar,
    end,
  };
}

/** Whether two sets of bar spans are the same (a redraw that changed nothing needs no update). */
export function sameSpans(a: readonly BarSpan[] | null, b: readonly BarSpan[] | null): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((s, i) => s.x === b[i]!.x && s.width === b[i]!.width);
}
