import { clipEndMs, lanesEndMs } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings } from "@/lib/tauri";

/**
 * Timeline zoom maths for the lane editor and the studio: a zoom is pixels per second, and a view
 * is the zoom with the scroller's `scrollLeft`. `offsetPx` is where the timeline starts inside the
 * scroller's content (the studio's lane headers sit to its left); view x is measured from the
 * scroller's left edge.
 */

/** The zoom range of a view, pixels per second. */
export interface ZoomLimits {
  readonly min: number;
  readonly max: number;
}

/** A stretch of the audio timeline, ms. */
export interface TimeSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** What the scroller shows: the zoom and the horizontal scroll. */
export interface ZoomView {
  readonly pxPerSecond: number;
  readonly scrollLeft: number;
}

/** What a wheel turn does: zoom by a factor around the pointer, scroll sideways, or the default. */
export type WheelAction =
  | { readonly kind: "zoom"; readonly factor: number }
  | { readonly kind: "scroll"; readonly dx: number }
  | { readonly kind: "native" };

/** The zoom buttons and the `=` and `-` keys step by this factor. */
export const ZOOM_STEP = 1.5;
/** Room left on each side when a span is fitted, px. */
export const FIT_MARGIN_PX = 16;
/** The shortest span a fit zooms to, ms (a click, not a stretch, would zoom in without end). */
export const MIN_FIT_SPAN_MS = 100;
/** How much a pixel of wheel turn zooms (about 22 % for a mouse wheel notch of 100). */
const WHEEL_ZOOM_RATE = 0.0025;
/** The largest wheel delta read at once, px (a fast flick would jump to the end of the range). */
const MAX_WHEEL_DELTA = 120;
/** A wheel delta in lines is this many pixels. */
const LINE_PX = 16;

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/** A zoom inside the limits. */
export function clampZoom(pxPerSecond: number, limits: ZoomLimits): number {
  return Math.min(limits.max, Math.max(limits.min, finiteOr(pxPerSecond, limits.min)));
}

/** Where a timeline point is in the scroller's content, px. */
export function contentXAtMs(ms: number, pxPerSecond: number, offsetPx = 0): number {
  return offsetPx + (ms / 1000) * pxPerSecond;
}

/** The timeline point under a view x, ms (never before the start). */
export function msAtViewX(view: ZoomView, viewX: number, offsetPx = 0): number {
  return Math.max(0, ((view.scrollLeft + viewX - offsetPx) / view.pxPerSecond) * 1000);
}

/**
 * The view at a new zoom that keeps `anchorMs` at `anchorViewX` (the point under the pointer or
 * the position line stays where it is on screen).
 */
export function zoomAt(
  pxPerSecond: number,
  anchorMs: number,
  anchorViewX: number,
  limits: ZoomLimits,
  offsetPx = 0,
): ZoomView {
  const next = clampZoom(pxPerSecond, limits);
  return {
    pxPerSecond: next,
    scrollLeft: Math.max(0, contentXAtMs(anchorMs, next, offsetPx) - anchorViewX),
  };
}

/**
 * Zooms by `factor` around a point of the view (the pointer): the timeline point under it stays
 * under it. A point over the lane headers counts as the timeline's left edge.
 */
export function zoomAroundViewX(
  view: ZoomView,
  factor: number,
  viewX: number,
  limits: ZoomLimits,
  offsetPx = 0,
): ZoomView {
  const x = Math.max(offsetPx, viewX);
  return zoomAt(view.pxPerSecond * factor, msAtViewX(view, x, offsetPx), x, limits, offsetPx);
}

/**
 * Zooms by `factor` around the position line: it stays where it is when it is in view, and comes
 * to the middle of the timeline when it is not.
 */
export function zoomAroundLine(
  view: ZoomView,
  factor: number,
  lineMs: number,
  viewportWidth: number,
  limits: ZoomLimits,
  offsetPx = 0,
): ZoomView {
  const lineX = contentXAtMs(lineMs, view.pxPerSecond, offsetPx) - view.scrollLeft;
  const inView = lineX >= offsetPx && lineX <= viewportWidth;
  const anchorX = inView ? lineX : offsetPx + Math.max(0, viewportWidth - offsetPx) / 2;
  return zoomAt(view.pxPerSecond * factor, lineMs, anchorX, limits, offsetPx);
}

/**
 * The view that shows `span` across the timeline's visible width, with a margin each side, its
 * start at the left. A span longer than the lowest zoom can show starts at the left all the same.
 */
export function fitSpan(
  span: TimeSpan,
  viewportWidth: number,
  limits: ZoomLimits,
  offsetPx = 0,
  marginPx = FIT_MARGIN_PX,
): ZoomView {
  const width = Math.max(1, viewportWidth - offsetPx - 2 * marginPx);
  const seconds = Math.max(MIN_FIT_SPAN_MS, span.endMs - span.startMs) / 1000;
  const pxPerSecond = clampZoom(width / seconds, limits);
  return {
    pxPerSecond,
    scrollLeft: Math.max(0, (Math.max(0, span.startMs) / 1000) * pxPerSecond - marginPx),
  };
}

/** The whole song: from the start to the last clip's end or the score's end, whichever is later. */
export function songSpan(audio: AudioLanesSettings, scoreEndMs: number): TimeSpan {
  return { startMs: 0, endMs: Math.max(lanesEndMs(audio), finiteOr(scoreEndMs, 0)) };
}

/**
 * What "Zoom to the selection" shows: the extent of the selected clips, else the time selection,
 * else nothing.
 */
export function selectionSpan(
  audio: AudioLanesSettings,
  clipIds: readonly string[],
  timeSelection: TimeSpan | null,
): TimeSpan | null {
  const clips = audio.lanes.flatMap((l) => l.clips).filter((c) => clipIds.includes(c.id));
  if (clips.length > 0)
    return {
      startMs: Math.min(...clips.map((c) => c.startMs)),
      endMs: Math.max(...clips.map(clipEndMs)),
    };
  if (timeSelection && timeSelection.endMs > timeSelection.startMs) return timeSelection;
  return null;
}

/**
 * What a wheel turn does over a timeline: with ⌘ or Ctrl (a trackpad pinch too) it zooms around
 * the pointer; a plain vertical turn scrolls sideways; a sideways swipe, Shift or ⌥/Alt keep the
 * default (⌥/Alt-wheel scrolls up and down through the lanes).
 */
export function wheelAction(event: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode?: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): WheelAction {
  const unit = event.deltaMode === 1 ? LINE_PX : 1;
  const dy = finiteOr(event.deltaY, 0) * unit;
  const dx = finiteOr(event.deltaX, 0) * unit;
  if (event.ctrlKey || event.metaKey) {
    if (dy === 0) return { kind: "native" };
    const delta = Math.min(MAX_WHEEL_DELTA, Math.max(-MAX_WHEEL_DELTA, dy));
    return { kind: "zoom", factor: Math.exp(-delta * WHEEL_ZOOM_RATE) };
  }
  if (event.shiftKey || event.altKey || dy === 0 || Math.abs(dx) >= Math.abs(dy)) {
    return { kind: "native" };
  }
  return { kind: "scroll", dx: dy };
}
