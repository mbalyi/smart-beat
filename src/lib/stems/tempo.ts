/**
 * The tempo of a separated song: what the detector found, what the user changed, and the maths
 * the tempo menu needs (halve, double, tap). Pure; the page keeps the state.
 */
import type { StemTempo } from "@/lib/tauri";

export const MIN_BPM = 30;
export const MAX_BPM = 300;

/** Below this the detector is not sure: the page says "Tempo not found". */
export const LOW_CONFIDENCE = 0.3;

/** What the user changed; each part wins over what was detected. */
export interface TempoOverride {
  bpm?: number;
  firstBeatSec?: number;
  /** Click along the detected tempo changes instead of one tempo. */
  followSections?: boolean;
}

/** The tempo the page works with. */
export interface EffectiveTempo {
  /** Null when nothing is known: not found and not set by hand. */
  bpm: number | null;
  firstBeatSec: number;
  /** The detector found it and the user did not change it. */
  detected: boolean;
  /** The detector was not sure (or failed) and the user has not set a tempo. */
  notFound: boolean;
  sections: StemTempo["sections"];
  followSections: boolean;
}

export const clampBpm = (bpm: number) => Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
const round1 = (value: number) => Math.round(value * 10) / 10;

/** A tempo the metronome and the menu can use, to one decimal. Null for nonsense. */
export function cleanBpm(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const bpm = round1(value);
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? bpm : null;
}

/** "92", "92.5". */
export const formatBpm = (bpm: number) => String(round1(bpm));

export const halve = (bpm: number) => cleanBpm(bpm / 2);
export const double = (bpm: number) => cleanBpm(bpm * 2);

/** The detector's other candidates, without the tempo in use and without repeats. */
export function otherTempos(alternatives: readonly number[], current: number | null): number[] {
  const seen = new Set<number>();
  if (current !== null) seen.add(round1(current));
  const out: number[] = [];
  for (const value of alternatives) {
    const bpm = cleanBpm(value);
    if (bpm === null || seen.has(bpm)) continue;
    seen.add(bpm);
    out.push(bpm);
  }
  return out;
}

/** Joins what was detected with what the user changed. */
export function effectiveTempo(
  detected: StemTempo | null,
  override: TempoOverride | undefined,
): EffectiveTempo {
  const sure = detected !== null && detected.confidence >= LOW_CONFIDENCE && detected.bpm > 0;
  const detectedBpm = sure ? cleanBpm(detected.bpm) : null;
  const bpm = override?.bpm ?? detectedBpm;
  const sections = sure && detected.sections.length > 1 ? detected.sections : [];
  return {
    bpm,
    firstBeatSec: override?.firstBeatSec ?? (sure ? Math.max(0, detected.firstBeatSec) : 0),
    detected: override?.bpm === undefined && detectedBpm !== null,
    notFound: bpm === null,
    sections,
    followSections:
      sections.length > 1 && override?.bpm === undefined && !!override?.followSections,
  };
}

// --- Tap tempo ----------------------------------------------------------------------------

/** A pause this long starts a new count of taps. */
export const TAP_RESET_MS = 2500;
/** How many of the latest taps are averaged. */
const TAP_WINDOW = 8;

/** The taps so far after one more at `now` (ms): the old ones are dropped after a pause. */
export function addTap(taps: readonly number[], now: number): number[] {
  const last = taps.at(-1);
  const kept = last !== undefined && now - last <= TAP_RESET_MS ? taps : [];
  return [...kept, now].slice(-TAP_WINDOW);
}

/** The tempo the taps (ms) tell, or null with fewer than two. */
export function tapBpm(taps: readonly number[]): number | null {
  if (taps.length < 2) return null;
  const span = taps[taps.length - 1]! - taps[0]!;
  if (span <= 0) return null;
  return cleanBpm((60000 * (taps.length - 1)) / span);
}

// --- Tempo changes ------------------------------------------------------------------------

/** The part of the song `seconds` is in. */
export function sectionAt(sections: StemTempo["sections"], seconds: number) {
  return sections.find((s) => seconds >= s.startSec && seconds < s.endSec) ?? sections.at(-1);
}

/** "92 BPM until 1:48, then 140 BPM". */
export function describeSections(
  sections: StemTempo["sections"],
  time: (seconds: number) => string,
): string {
  return sections
    .map((section, index) => {
      const last = index === sections.length - 1;
      const bpm = `${formatBpm(section.bpm)} BPM`;
      if (index === 0) return last ? bpm : `${bpm} until ${time(section.endSec)}`;
      return last ? `then ${bpm}` : `then ${bpm} until ${time(section.endSec)}`;
    })
    .join(", ");
}

// --- Remembering --------------------------------------------------------------------------

const memory = new Map<string, TempoOverride>();
const storageKey = (id: string) => `smart-beat:stem-tempo:${id}`;

function isOverride(value: unknown): value is TempoOverride {
  return typeof value === "object" && value !== null;
}

/** What the user changed for a song: in memory for this session, else from localStorage. */
export function readOverride(id: string): TempoOverride {
  const known = memory.get(id);
  if (known) return known;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(id)) ?? "null");
    if (!isOverride(stored)) return {};
    const override: TempoOverride = {};
    const bpm = typeof stored.bpm === "number" ? cleanBpm(stored.bpm) : null;
    if (bpm !== null) override.bpm = bpm;
    if (typeof stored.firstBeatSec === "number" && stored.firstBeatSec >= 0) {
      override.firstBeatSec = stored.firstBeatSec;
    }
    if (stored.followSections === true) override.followSections = true;
    memory.set(id, override);
    return override;
  } catch {
    return {};
  }
}

export function writeOverride(id: string, override: TempoOverride): void {
  memory.set(id, override);
  try {
    if (Object.keys(override).length === 0) localStorage.removeItem(storageKey(id));
    else localStorage.setItem(storageKey(id), JSON.stringify(override));
  } catch {
    // Storage can be unavailable (private mode): the change lasts until the app closes.
  }
}

/** For tests: forget what is kept in memory. */
export function forgetOverrides(): void {
  memory.clear();
}
