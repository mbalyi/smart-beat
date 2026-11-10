import { MAX_GAIN_DB, MIN_GAIN_DB, NO_FADE, clipEndMs } from "@/lib/audio-lanes/model";
import type { AudioClip, ClipFade, FadeShape } from "@/lib/tauri";

/** Which end of a clip a fade handle belongs to. */
export type FadeEdge = "in" | "out";

/** A clip narrower than this (px) shows no fade or volume handles. */
export const HANDLE_MIN_CLIP_PX = 48;
/** Volume change per pixel of vertical drag on the top edge, and with Shift held. */
export const DB_PER_PX = 0.25;
export const FINE_DB_PER_PX = 0.025;
/** Volume keyboard steps (arrows, with Shift, Page Up/Down), in dB. */
export const GAIN_STEP_DB = 1;
export const FINE_GAIN_STEP_DB = 0.1;
export const GAIN_PAGE_DB = 6;
/** Fade keyboard steps (arrows, with Shift, Page Up/Down), in ms of source time. */
export const FADE_STEP_MS = 50;
export const FINE_FADE_STEP_MS = 5;
export const FADE_PAGE_MS = 500;

export const FADE_SHAPE_LABELS: readonly { value: FadeShape; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "equalPower", label: "Equal power" },
  { value: "sCurve", label: "S-curve" },
];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const fadeOf = (clip: AudioClip, edge: FadeEdge): ClipFade =>
  edge === "in" ? clip.fadeIn : clip.fadeOut;

const otherEdge = (edge: FadeEdge): FadeEdge => (edge === "in" ? "out" : "in");

/** The longest fade `edge` can have, in source ms: the clip less the fade at its other end. */
export function maxFadeMs(clip: AudioClip, edge: FadeEdge): number {
  return Math.max(0, clip.lengthMs - fadeOf(clip, otherEdge(edge)).ms);
}

/** A fade length rounded to whole ms and kept between 0 and `maxFadeMs`. */
export function clampFadeMs(clip: AudioClip, edge: FadeEdge, ms: number): number {
  const safe = Number.isFinite(ms) ? ms : 0;
  return clamp(Math.round(safe), 0, Math.floor(maxFadeMs(clip, edge)));
}

/** How wide a fade is on screen (px), given the timeline mapping `toX`. */
export function fadeWidthPx(clip: AudioClip, edge: FadeEdge, toX: (ms: number) => number): number {
  const ms = fadeOf(clip, edge).ms / clip.playrate;
  if (ms <= 0) return 0;
  return edge === "in"
    ? toX(clip.startMs + ms) - toX(clip.startMs)
    : toX(clipEndMs(clip)) - toX(clipEndMs(clip) - ms);
}

/** Where a fade's handle is on the timeline (px): the inner end of the fade. */
export function fadeHandleX(clip: AudioClip, edge: FadeEdge, toX: (ms: number) => number): number {
  const ms = fadeOf(clip, edge).ms / clip.playrate;
  return edge === "in" ? toX(clip.startMs + ms) : toX(clipEndMs(clip) - ms);
}

/** The fade length (source ms) when its handle is dragged to `x` on the timeline (px). */
export function fadeMsAtX(
  clip: AudioClip,
  edge: FadeEdge,
  x: number,
  toMs: (x: number) => number,
): number {
  const timelineMs = edge === "in" ? toMs(x) - clip.startMs : clipEndMs(clip) - toMs(x);
  return clampFadeMs(clip, edge, timelineMs * clip.playrate);
}

const fadeKey = (edge: FadeEdge) => (edge === "in" ? "fadeIn" : "fadeOut");

/** The clip change that gives `edge` a fade of `ms`; a fade set by hand is no longer automatic. */
export function fadeLengthPatch(clip: AudioClip, edge: FadeEdge, ms: number): Partial<AudioClip> {
  const fade: ClipFade = { ms: clampFadeMs(clip, edge, ms), shape: fadeOf(clip, edge).shape };
  return { [fadeKey(edge)]: fade };
}

/** The clip change that gives the fade at `edge` the curve `shape`. */
export function fadeShapePatch(
  clip: AudioClip,
  edge: FadeEdge,
  shape: FadeShape,
): Partial<AudioClip> {
  const fade: ClipFade = { ms: fadeOf(clip, edge).ms, shape };
  return { [fadeKey(edge)]: fade };
}

/** The clip change that takes the fade at `edge` away. */
export function removeFadePatch(edge: FadeEdge): Partial<AudioClip> {
  return { [fadeKey(edge)]: NO_FADE };
}

/** A gain kept in range and rounded to 0.1 dB. */
export function clampGainDb(db: number): number {
  const safe = Number.isFinite(db) ? db : 0;
  return Math.round(clamp(safe, MIN_GAIN_DB, MAX_GAIN_DB) * 10) / 10;
}

/**
 * The gain after the top edge is dragged `dyPx` down (negative: up), unrounded so slow drags add
 * up; `fine` (Shift) moves it a tenth as fast.
 */
export function gainAfterDrag(db: number, dyPx: number, fine: boolean): number {
  return clamp(db - dyPx * (fine ? FINE_DB_PER_PX : DB_PER_PX), MIN_GAIN_DB, MAX_GAIN_DB);
}

interface SliderSteps {
  step: number;
  page: number;
  min: number;
  max: number;
}

/** The value a slider key gives (arrows, Page Up/Down, Home, End), or null for other keys. */
export function sliderKeyValue(key: string, value: number, steps: SliderSteps): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(value + steps.step, steps.min, steps.max);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(value - steps.step, steps.min, steps.max);
    case "PageUp":
      return clamp(value + steps.page, steps.min, steps.max);
    case "PageDown":
      return clamp(value - steps.page, steps.min, steps.max);
    case "Home":
      return steps.min;
    case "End":
      return steps.max;
    default:
      return null;
  }
}

/** The fade length a key gives on a focused fade handle, or null for other keys. */
export function fadeKeyMs(
  clip: AudioClip,
  edge: FadeEdge,
  key: string,
  fine: boolean,
): number | null {
  const next = sliderKeyValue(key, fadeOf(clip, edge).ms, {
    step: fine ? FINE_FADE_STEP_MS : FADE_STEP_MS,
    page: FADE_PAGE_MS,
    min: 0,
    max: maxFadeMs(clip, edge),
  });
  return next === null ? null : clampFadeMs(clip, edge, next);
}

/** The gain a key gives on the focused volume handle, or null for other keys. */
export function gainKeyDb(db: number, key: string, fine: boolean): number | null {
  const next = sliderKeyValue(key, db, {
    step: fine ? FINE_GAIN_STEP_DB : GAIN_STEP_DB,
    page: GAIN_PAGE_DB,
    min: MIN_GAIN_DB,
    max: MAX_GAIN_DB,
  });
  return next === null ? null : clampGainDb(next);
}

/** A gain as the handles show it: "+3.5 dB", "0.0 dB", "-6.0 dB". */
export function formatGainDb(db: number): string {
  const rounded = clampGainDb(db);
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)} dB`;
}

/** A fade length as the handles show it: "200 ms". */
export function formatFadeMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}
