/**
 * Keeping the cursor in step with what is heard.
 *
 * alphaTab reports the playback position when samples are handed to the audio
 * graph, not when the speakers play them, so the cursor and the note
 * highlighting run ahead by the audio output latency (a few milliseconds on
 * built-in speakers, hundreds on Bluetooth). alphaTab has no setting for it, so
 * the adapter delays what it shows while playing by that latency.
 */
import { midi } from "@coderline/alphatab";

/** The most the cursor is ever delayed. */
export const MAX_LATENCY_MS = 500;

/** The user's sync offset in milliseconds (added to the measured latency). */
export const SYNC_OFFSET_STORAGE_KEY = "smart-beat:sync-offset";
export const MIN_SYNC_OFFSET_MS = -200;
export const MAX_SYNC_OFFSET_MS = 500;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** What an AudioContext reports about its delay (seconds). Safari often reports none. */
export interface LatencyInfo {
  outputLatency?: number;
  baseLatency?: number;
}

declare global {
  interface Window {
    /** Tests: pretend the audio output has this latency (ms). */
    __smartBeatOutputLatencyMs?: number;
  }
}

/** How long the cursor is delayed: the device's latency plus the user's offset, clamped to 0…500 ms. */
export function outputLatencyMs(info: LatencyInfo | null, offsetMs = 0): number {
  const injected = typeof window !== "undefined" ? window.__smartBeatOutputLatencyMs : undefined;
  const measured =
    injected !== undefined
      ? finite(injected)
      : (finite(info?.outputLatency) + finite(info?.baseLatency)) * 1000;
  return clamp(measured + finite(offsetMs), 0, MAX_LATENCY_MS);
}

let syncOffset: number | null = null;

export function readSyncOffset(): number {
  if (syncOffset !== null) return syncOffset;
  try {
    const stored = Number(localStorage.getItem(SYNC_OFFSET_STORAGE_KEY));
    syncOffset = Number.isFinite(stored)
      ? clamp(stored, MIN_SYNC_OFFSET_MS, MAX_SYNC_OFFSET_MS)
      : 0;
  } catch {
    syncOffset = 0;
  }
  return syncOffset;
}

export function storeSyncOffset(ms: number) {
  syncOffset = clamp(Math.round(finite(ms)), MIN_SYNC_OFFSET_MS, MAX_SYNC_OFFSET_MS);
  try {
    localStorage.setItem(SYNC_OFFSET_STORAGE_KEY, String(syncOffset));
  } catch {
    // Not remembered: 0 next time.
  }
}

/** Forgets the cached offset (tests, and storage that changed elsewhere). */
export function resetSyncOffsetCache() {
  syncOffset = null;
}

/**
 * Asks the audio system how late sound comes out: starts a short-lived
 * AudioContext (the same device alphaTab plays through), reads its latency
 * and closes it again. Returns nothing known where the browser can't say.
 */
export async function measureLatency(): Promise<LatencyInfo> {
  try {
    const Context = typeof AudioContext === "undefined" ? undefined : AudioContext;
    if (!Context) return {};
    const context = new Context({ latencyHint: "interactive" });
    try {
      await context.resume();
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { outputLatency: context.outputLatency, baseLatency: context.baseLatency };
    } finally {
      void context.close().catch(() => {});
    }
  } catch {
    return {};
  }
}

/** Runs things after a delay that can change, in order, and can be cancelled (after a seek). */
export class Delayer {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private readonly delay: () => number;

  /** `delay` is asked each time: 0 (not playing) runs `task` at once. */
  constructor(delay: () => number) {
    this.delay = delay;
  }

  run(task: () => void) {
    const ms = this.delay();
    if (ms <= 0) {
      task();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      task();
    }, ms);
    this.timers.add(timer);
  }

  /** Drops what is waiting: it belongs to a position the user has just left. */
  clear() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

/** The parts of alphaTab's cursor elements that the handler uses. */
interface CursorElement {
  setBounds(x: number, y: number, w: number, h: number): void;
  transitionToX(duration: number, x: number): void;
}
interface BeatBoundsLike {
  onNotesX: number;
  barBounds: { masterBarBounds: { visualBounds: { x: number; y: number; w: number; h: number } } };
}

/**
 * alphaTab's own cursor placement (animated to the next beat, or snapping),
 * moved by `delayer` so the cursor is where the music is heard.
 */
export function createCursorHandler(
  delayer: Delayer,
  animated: boolean,
  /** Called (delayed like the cursor) with the bar the cursor moved into: scroll it into view. */
  onBar?: (bar: { x: number; y: number; w: number; h: number }) => void,
) {
  const toNextBeat = midi.MidiTickLookupFindBeatResultCursorMode.ToNextBext;
  return {
    onAttach() {},
    onDetach() {},
    placeBarCursor(barCursor: CursorElement, beatBounds: BeatBoundsLike) {
      delayer.run(() => {
        const bar = beatBounds.barBounds.masterBarBounds.visualBounds;
        barCursor.setBounds(bar.x, bar.y, bar.w, bar.h);
        onBar?.(bar);
      });
    },
    placeBeatCursor(beatCursor: CursorElement, beatBounds: BeatBoundsLike, startBeatX: number) {
      delayer.run(() => {
        const bar = beatBounds.barBounds.masterBarBounds.visualBounds;
        const x = animated ? startBeatX : beatBounds.onNotesX;
        beatCursor.transitionToX(0, x);
        beatCursor.setBounds(x, bar.y, 1, bar.h);
      });
    },
    transitionBeatCursor(
      beatCursor: CursorElement,
      beatBounds: BeatBoundsLike,
      startBeatX: number,
      nextBeatX: number,
      duration: number,
      cursorMode: number,
    ) {
      delayer.run(() => {
        if (!animated) {
          const bar = beatBounds.barBounds.masterBarBounds.visualBounds;
          beatCursor.transitionToX(0, beatBounds.onNotesX);
          beatCursor.setBounds(beatBounds.onNotesX, bar.y, 1, bar.h);
          return;
        }
        const factor = cursorMode === toNextBeat ? 2 : 1;
        beatCursor.transitionToX(duration * factor, startBeatX + (nextBeatX - startBeatX) * factor);
      });
    },
  };
}

/** Space kept above (or left of) the bar being played when the score scrolls to it (px). */
export const SCROLL_MARGIN = 40;

/**
 * Where to scroll so `bar` is fully visible: the new scroll position, or null
 * if it is visible already. Vertical for page layout, horizontal otherwise.
 */
export function scrollTarget(
  bar: { x: number; y: number; w: number; h: number },
  view: { scrollTop: number; scrollLeft: number; clientHeight: number; clientWidth: number },
  horizontal: boolean,
): number | null {
  const [start, size, scroll, extent] = horizontal
    ? [bar.x, bar.w, view.scrollLeft, view.clientWidth]
    : [bar.y, bar.h, view.scrollTop, view.clientHeight];
  if (start >= scroll && start + size <= scroll + extent) return null;
  return Math.max(0, start - SCROLL_MARGIN);
}
