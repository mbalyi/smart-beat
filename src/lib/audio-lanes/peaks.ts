/** Waveform peaks of clips, and the gain that normalizes them. */
import { MAX_GAIN_DB, MIN_GAIN_DB, activeTake } from "@/lib/audio-lanes/model";
import type { AudioClip, SourceInfo } from "@/lib/tauri";

/** The peaks of the part of a source a clip plays (reversed for a reversed clip). */
export function clipPeaks(clip: AudioClip, info: SourceInfo | undefined): number[] {
  if (!info) return [];
  const take = activeTake(clip);
  const per = info.peaksPerSecond / 1000;
  const total = info.peaks.length;
  const from = Math.max(0, Math.floor(take.offsetMs * per));
  const to = Math.min(total, Math.ceil((take.offsetMs + clip.lengthMs) * per));
  const slice = clip.reversed
    ? info.peaks.slice(Math.max(0, total - to), Math.max(0, total - from)).reverse()
    : info.peaks.slice(from, to);
  const gain = 10 ** (clip.gainDb / 20);
  return gain === 1 ? slice : slice.map((p) => Math.min(1, p * gain));
}

/** The gain that brings a clip's loudest peak to 0 dB (normalize), in dB. */
export function normalizeGainDb(peaks: readonly number[], currentDb: number): number {
  const loudest = peaks.reduce((m, p) => Math.max(m, p), 0) / 10 ** (currentDb / 20);
  if (loudest <= 0) return currentDb;
  return Math.min(
    MAX_GAIN_DB,
    Math.max(MIN_GAIN_DB, Math.round(-20 * Math.log10(loudest) * 10) / 10),
  );
}
