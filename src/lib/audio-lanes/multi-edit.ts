import { updateClip } from "@/lib/audio-lanes/edits";
import {
  MAX_CENTS,
  MAX_GAIN_DB,
  MAX_PLAYRATE,
  MAX_SEMITONES,
  MIN_GAIN_DB,
  MIN_PLAYRATE,
} from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings, FadeShape } from "@/lib/tauri";

type Audio = AudioLanesSettings;

/** Numbers closer than this count as the same value (rounding errors from edits). */
const SAME_NUMBER = 1e-6;

/** A field's value across several clips: the one they share, or mixed when they differ. */
export type Shared<T> = { mixed: false; value: T } | { mixed: true };

/** Whether a set of clips is edited to one value or by a change added to each clip's own value. */
export type EditMode = "absolute" | "relative";

/** The numeric clip fields the multi-clip panel edits. */
export type NumberField = "gainDb" | "semitones" | "cents" | "playrate";

/** The on/off clip fields the multi-clip panel edits. */
export type FlagField = "mute" | "locked" | "reversed" | "preservePitch";

/** Which end of a clip a fade is at. */
export type FadeEnd = "fadeIn" | "fadeOut";

/** The numeric fields a relative change applies to (the playrate is always set). */
export const RELATIVE_FIELDS: readonly NumberField[] = ["gainDb", "semitones", "cents"];

/** The range of each numeric field, and whether it takes whole steps only. */
export const FIELD_LIMITS: Readonly<
  Record<NumberField, { min: number; max: number; whole: boolean }>
> = {
  gainDb: { min: MIN_GAIN_DB, max: MAX_GAIN_DB, whole: false },
  semitones: { min: -MAX_SEMITONES, max: MAX_SEMITONES, whole: true },
  cents: { min: -MAX_CENTS, max: MAX_CENTS, whole: true },
  playrate: { min: MIN_PLAYRATE, max: MAX_PLAYRATE, whole: false },
};

/** The values the shared fields of several clips have, each one shared or mixed. */
export interface ClipsSummary {
  gainDb: Shared<number>;
  semitones: Shared<number>;
  cents: Shared<number>;
  playrate: Shared<number>;
  preservePitch: Shared<boolean>;
  fadeInMs: Shared<number>;
  fadeInShape: Shared<FadeShape>;
  fadeOutMs: Shared<number>;
  fadeOutShape: Shared<FadeShape>;
  mute: Shared<boolean>;
  locked: Shared<boolean>;
  reversed: Shared<boolean>;
}

const same = <T>(a: T, b: T): boolean =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < SAME_NUMBER : a === b;

/** The value every item has, or mixed when they differ (or when there are none). */
export function shared<T>(values: readonly T[]): Shared<T> {
  if (values.length === 0) return { mixed: true };
  const [first] = values as [T, ...T[]];
  return values.every((v) => same(v, first)) ? { mixed: false, value: first } : { mixed: true };
}

/** The clips with these ids, in lane order; ids of clips that no longer exist are skipped. */
export function selectedClips(audio: Audio, ids: readonly string[]): AudioClip[] {
  const wanted = new Set(ids);
  return audio.lanes.flatMap((l) => l.clips.filter((c) => wanted.has(c.id)));
}

/** Each shared field across the clips: its common value, or mixed. */
export function summarizeClips(clips: readonly AudioClip[]): ClipsSummary {
  const of = <T>(get: (clip: AudioClip) => T) => shared(clips.map(get));
  return {
    gainDb: of((c) => c.gainDb),
    semitones: of((c) => c.semitones),
    cents: of((c) => c.cents),
    playrate: of((c) => c.playrate),
    preservePitch: of((c) => c.preservePitch),
    fadeInMs: of((c) => c.fadeIn.ms),
    fadeInShape: of((c) => c.fadeIn.shape),
    fadeOutMs: of((c) => c.fadeOut.ms),
    fadeOutShape: of((c) => c.fadeOut.shape),
    mute: of((c) => c.mute),
    locked: of((c) => c.locked),
    reversed: of((c) => c.reversed),
  };
}

/** A value inside the field's limits (whole steps for pitch; not a number counts as 0). */
export function clampField(field: NumberField, value: number): number {
  const { min, max, whole } = FIELD_LIMITS[field];
  const finite = Number.isFinite(value) ? value : 0;
  const stepped = whole ? Math.round(finite) : finite;
  return Math.min(max, Math.max(min, stepped));
}

/**
 * The patch that edits one clip's field: `value` itself (absolute), or the clip's own value plus
 * `value` (relative, gain and pitch only), clamped to the field's limits.
 */
export function numberPatch(
  clip: AudioClip,
  field: NumberField,
  mode: EditMode,
  value: number,
): Partial<AudioClip> {
  const relative = mode === "relative" && RELATIVE_FIELDS.includes(field);
  return { [field]: clampField(field, relative ? clip[field] + value : value) };
}

/** Whether a patch gives a clip a value it does not have yet. */
function changes(clip: AudioClip, patch: Partial<AudioClip>): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const current: unknown = clip[key as keyof AudioClip];
    return typeof value === "object"
      ? JSON.stringify(value) !== JSON.stringify(current)
      : !same(value, current);
  });
}

/**
 * Each clip with these ids patched (patches are normalized). The same settings come back when no
 * such clip exists or no patch changes anything, so an edit that does nothing adds no undo step.
 */
export function editClips(
  audio: Audio,
  ids: readonly string[],
  patchFor: (clip: AudioClip) => Partial<AudioClip>,
): Audio {
  const edits = selectedClips(audio, ids)
    .map((clip) => ({ id: clip.id, patch: patchFor(clip), clip }))
    .filter((e) => changes(e.clip, e.patch));
  return edits.reduce((next, e) => updateClip(next, e.id, e.patch), audio);
}

/** Sets (or, relative, changes) a numeric field on every clip with these ids. */
export function setNumber(
  audio: Audio,
  ids: readonly string[],
  field: NumberField,
  mode: EditMode,
  value: number,
): Audio {
  return editClips(audio, ids, (clip) => numberPatch(clip, field, mode, value));
}

/** Turns an on/off field on or off on every clip with these ids. */
export function setFlag(audio: Audio, ids: readonly string[], field: FlagField, on: boolean) {
  return editClips(audio, ids, () => ({ [field]: on }));
}

/** Sets a fade's length on every clip with these ids (each kept within its own clip). */
export function setFadeLength(audio: Audio, ids: readonly string[], end: FadeEnd, ms: number) {
  return editClips(audio, ids, (clip) => ({ [end]: { ...clip[end], ms: Math.max(0, ms) } }));
}

/** Sets a fade's curve on every clip with these ids, keeping each clip's fade length. */
export function setFadeShape(audio: Audio, ids: readonly string[], end: FadeEnd, shape: FadeShape) {
  return editClips(audio, ids, (clip) => ({ [end]: { ...clip[end], shape } }));
}
