import { clipDuration, findClip, removeClips, splitClip } from "@/lib/audio-lanes/edits";
import { MIN_CLIP_MS, activeTake, newId } from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings, SilentRegion } from "@/lib/tauri";

type Audio = AudioLanesSettings;

/** A stretch of a clip's timeline, in ms from the clip's start. */
export interface Span {
  from: number;
  to: number;
}

/** A piece of a clip once it is cut at its quiet parts. */
export interface Piece extends Span {
  quiet: boolean;
}

/** Why a clip was left as it is. */
export type SilenceSkipReason = "stretched" | "locked" | "unknown";

export interface SilenceSkip {
  clipId: string;
  reason: SilenceSkipReason;
}

export interface SilenceResult {
  audio: Audio;
  /** How many quiet pieces were taken out. */
  removed: number;
  /** How many clips lost a quiet piece. */
  clips: number;
  skipped: SilenceSkip[];
}

/** Slack for rounding, in ms. */
const EPSILON = 0.001;

/**
 * The quiet parts of a clip's file (file ms) as spans of the clip's timeline: only the part of
 * the file the clip plays, at its playrate, mirrored for a reversed clip. Sorted and merged.
 * A stretched clip's timeline does not map linearly to its file; give it no regions.
 */
export function quietSpans(clip: AudioClip, regions: readonly SilentRegion[]): Span[] {
  const { offsetMs } = activeTake(clip);
  const end = offsetMs + clip.lengthMs;
  const spans = regions
    .map((r) => ({ from: Math.max(r.startMs, offsetMs), to: Math.min(r.endMs, end) }))
    .filter((r) => r.to - r.from > EPSILON)
    .map((r) =>
      // Playing order: a reversed clip plays its file from the end back to the offset.
      clip.reversed
        ? { from: end - r.to, to: end - r.from }
        : { from: r.from - offsetMs, to: r.to - offsetMs },
    )
    .map((r) => ({ from: r.from / clip.playrate, to: r.to / clip.playrate }))
    .sort((a, b) => a.from - b.from);
  return spans.reduce<Span[]>((merged, span) => {
    const last = merged[merged.length - 1];
    return last && span.from <= last.to
      ? [...merged.slice(0, -1), { from: last.from, to: Math.max(last.to, span.to) }]
      : [...merged, span];
  }, []);
}

/**
 * The pieces a clip is cut into, every one long enough to be a clip of its own: a sliver of
 * sound at either end of the clip or between two quiet spans goes with the quiet part, and a
 * quiet span too short to cut out is kept.
 */
export function silencePieces(clip: AudioClip, spans: readonly Span[]): Piece[] {
  const duration = clipDuration(clip);
  const shortest = MIN_CLIP_MS / clip.playrate + EPSILON;
  const snapped = spans.map((s) => ({
    from: s.from < shortest ? 0 : s.from,
    to: s.to > duration - shortest ? duration : s.to,
  }));
  const joined = snapped.reduce<Span[]>((all, span) => {
    const last = all[all.length - 1];
    return last && span.from - last.to < shortest
      ? [...all.slice(0, -1), { from: last.from, to: Math.max(last.to, span.to) }]
      : [...all, span];
  }, []);
  const quiet = joined.filter((s) => s.to - s.from >= shortest);
  if (quiet.length === 0) return [{ from: 0, to: duration, quiet: false }];
  const pieces: Piece[] = [];
  let at = 0;
  for (const span of quiet) {
    if (span.from > at) pieces.push({ from: at, to: span.from, quiet: false });
    pieces.push({ ...span, quiet: true });
    at = span.to;
  }
  if (at < duration) pieces.push({ from: at, to: duration, quiet: false });
  return pieces;
}

/** Why a clip cannot lose its quiet parts, or null when it can. */
export function silenceSkipReason(
  clip: AudioClip,
  regions: readonly SilentRegion[] | undefined,
): SilenceSkipReason | null {
  if (clip.locked) return "locked";
  if (clip.stretch.length > 0) return "stretched";
  if (!regions) return "unknown";
  return null;
}

/**
 * Cuts one clip at the edges of its quiet pieces and deletes those pieces. Every new edge gets
 * the short cut fade of a split; with ripple on, the clips after a removed piece close the gap.
 */
function removeFromClip(
  audio: Audio,
  clip: AudioClip,
  pieces: readonly Piece[],
  makeId: () => string,
): { audio: Audio; removed: number } {
  if (!pieces.some((p) => p.quiet)) return { audio, removed: 0 };
  let next = audio;
  let rest = clip.id;
  const ids: string[] = [];
  for (const piece of pieces.slice(0, -1)) {
    const cut: [string, string] = [makeId(), makeId()];
    const split = splitClip(next, rest, clip.startMs + piece.to, cut);
    // A cut that would leave a piece too short to be a clip: leave this clip as it was.
    if (split === next) return { audio, removed: 0 };
    next = split;
    ids.push(cut[0]);
    rest = cut[1];
  }
  ids.push(rest);
  const quiet = ids.filter((_, i) => pieces[i]!.quiet);
  return { audio: removeClips(next, quiet), removed: quiet.length };
}

/**
 * "Remove silence" on clips: each is cut at the quiet parts of its file (`regions`, by source id,
 * in file ms) and those parts are deleted, as one edit. Locked and stretched clips, and clips
 * whose file has not been measured, are left as they are and listed in `skipped`.
 */
export function removeSilence(
  audio: Audio,
  clipIds: readonly string[],
  regions: ReadonlyMap<string, readonly SilentRegion[]>,
  makeId: () => string = newId,
): SilenceResult {
  return clipIds.reduce<SilenceResult>(
    (result, clipId) => {
      const found = findClip(result.audio, clipId);
      if (!found) return result;
      const clip = found.clip;
      const own = regions.get(activeTake(clip).sourceId);
      const reason = silenceSkipReason(clip, own);
      if (reason) return { ...result, skipped: [...result.skipped, { clipId, reason }] };
      const pieces = silencePieces(clip, quietSpans(clip, own ?? []));
      const done = removeFromClip(result.audio, clip, pieces, makeId);
      return {
        ...result,
        audio: done.audio,
        removed: result.removed + done.removed,
        clips: result.clips + (done.removed > 0 ? 1 : 0),
      };
    },
    { audio, removed: 0, clips: 0, skipped: [] },
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the preview line says the edit will do. */
export function silencePreview(result: Pick<SilenceResult, "removed" | "clips">): string {
  if (result.removed === 0) return "No quiet parts found with these settings.";
  return `${plural(result.removed, "quiet piece", "quiet pieces")} will be removed from ${plural(result.clips, "clip", "clips")}.`;
}

/** A sentence about the clips left as they are, or null when none were. */
export function skippedMessage(skipped: readonly SilenceSkip[]): string | null {
  const count = (reason: SilenceSkipReason) => skipped.filter((s) => s.reason === reason).length;
  const parts = [
    count("stretched") &&
      `${plural(count("stretched"), "stretched clip", "stretched clips")} (clear the stretch markers first)`,
    count("locked") && `${plural(count("locked"), "locked clip", "locked clips")} (unlock first)`,
    count("unknown") &&
      `${plural(count("unknown"), "clip", "clips")} whose audio file is not loaded`,
  ].filter((p): p is string => typeof p === "string");
  return parts.length ? `Left as they are: ${parts.join(", ")}.` : null;
}
