/**
 * How a track is played back, beyond what is written (Guitar Pro 8's
 * Interpretation section): playing style, how strongly palm mutes and accents
 * come out, and automatic let ring and brush (strum). Applied to the MIDI
 * alphaTab generates (its `midiLoad` event), so both audio engines hear it.
 * The score itself is not changed.
 */
import { midi } from "@coderline/alphatab";

import { realStaves } from "@/lib/score/drum-tab";
import type { Score } from "@/lib/score/model";

const { NoteOffEvent, NoteOnEvent } = midi;

export type PlayingStyle = "pick" | "fingers" | "slap";

export interface Interpretation {
  style: PlayingStyle;
  /** How muted palm-muted notes sound: 0 (barely) … 1 (very). */
  palmMute: number;
  /** How much accented notes stand out: 0 (not) … 1 (a lot). */
  accent: number;
  /** Notes ring on into the next beats, as if every note had let ring. */
  letRing: boolean;
  /** Chords are strummed (notes a few milliseconds apart, low to high). */
  brush: boolean;
}

export const DEFAULT_INTERPRETATION: Interpretation = {
  style: "pick",
  palmMute: 0.5,
  accent: 0.5,
  letRing: false,
  brush: false,
};

export const PLAYING_STYLES: { value: PlayingStyle; label: string }[] = [
  { value: "pick", label: "Pick" },
  { value: "fingers", label: "Fingers" },
  { value: "slap", label: "Slap" },
];

/** Velocity factor of each style (fingers are softer, slaps harder). */
const STYLE_VELOCITY: Record<PlayingStyle, number> = { pick: 1, fingers: 0.85, slap: 1.15 };
/** How long a let-ring note may sound (quarter notes). */
const LET_RING_QUARTERS = 4;
/** Strum spread between the notes of a chord (fraction of a quarter note). */
const BRUSH_STEP = 1 / 48;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const isDefaultInterpretation = (i: Interpretation) =>
  i.style === "pick" && i.palmMute === 0.5 && i.accent === 0.5 && !i.letRing && !i.brush;

/** A valid interpretation from stored data (unknown values fall back to the defaults). */
export function normalizeInterpretation(
  value: Partial<Interpretation> | null | undefined,
): Interpretation {
  const v = value ?? {};
  return {
    style: PLAYING_STYLES.some((s) => s.value === v.style)
      ? v.style!
      : DEFAULT_INTERPRETATION.style,
    palmMute: Number.isFinite(v.palmMute)
      ? clamp(v.palmMute!, 0, 1)
      : DEFAULT_INTERPRETATION.palmMute,
    accent: Number.isFinite(v.accent) ? clamp(v.accent!, 0, 1) : DEFAULT_INTERPRETATION.accent,
    letRing: v.letRing === true,
    brush: v.brush === true,
  };
}

/** Notes (by tick and key) of a track that are palm-muted or accented, from the score. */
function markedNotes(score: Score, trackIndex: number, lookup: midi.MidiTickLookup, shift: number) {
  const palmMuted = new Set<string>();
  const accented = new Set<string>();
  const track = score.tracks[trackIndex];
  if (!track) return { palmMuted, accented };
  for (const occurrence of lookup.masterBars) {
    for (const staff of realStaves(track)) {
      const bar = staff.bars[occurrence.masterBar.index];
      for (const voice of bar?.voices ?? []) {
        for (const beat of voice.beats) {
          const tick = occurrence.start + beat.playbackStart + shift;
          for (const note of beat.notes) {
            const key = `${tick}:${note.calculateRealValue(false, true)}`;
            if (note.isPalmMute) palmMuted.add(key);
            if (note.accentuated) accented.add(key);
          }
        }
      }
    }
  }
  return { palmMuted, accented };
}

/**
 * Applies each track's interpretation to `file` (in place). `channels[i]` are
 * track i's MIDI channels. Returns how many note events were changed.
 */
export function applyInterpretation(
  file: midi.MidiFile,
  score: Score,
  lookup: midi.MidiTickLookup | null,
  interpretations: readonly (Interpretation | undefined)[],
  channels: readonly number[][],
): number {
  let changed = 0;
  const quarter = file.division;
  interpretations.forEach((value, trackIndex) => {
    if (!value || isDefaultInterpretation(value)) return;
    const track = score.tracks[trackIndex];
    if (!track || track.staves[0]?.isPercussion) return; // drums keep their dynamics
    const own = new Set(channels[trackIndex] ?? []);
    const marks = lookup ? markedNotes(score, trackIndex, lookup, file.tickShift) : null;

    for (const midiTrack of file.tracks) {
      const ons = midiTrack.events.filter(
        (e): e is midi.NoteOnEvent => e instanceof NoteOnEvent && own.has(e.channel),
      );
      const offs = midiTrack.events.filter(
        (e): e is midi.NoteOffEvent => e instanceof NoteOffEvent && own.has(e.channel),
      );

      // Dynamics: style, palm-mute and accent strength (0.5 is alphaTab's own sound).
      for (const on of ons) {
        let velocity = on.noteVelocity * STYLE_VELOCITY[value.style];
        const key = `${on.tick}:${on.noteKey}`;
        if (marks?.palmMuted.has(key)) velocity *= 1 - (value.palmMute - 0.5) * 0.5;
        if (marks?.accented.has(key)) velocity *= 1 + (value.accent - 0.5) * 0.5;
        const next = clamp(Math.round(velocity), 1, 127);
        if (next !== on.noteVelocity) {
          on.noteVelocity = next;
          changed++;
        }
      }

      // Brush: the notes of a chord one after another, low to high.
      if (value.brush) {
        const chords = new Map<string, midi.NoteOnEvent[]>();
        for (const on of ons) {
          const key = `${on.channel}:${on.tick}`;
          chords.set(key, [...(chords.get(key) ?? []), on]);
        }
        const step = Math.max(1, Math.round(quarter * BRUSH_STEP));
        for (const chord of chords.values()) {
          if (chord.length < 3) continue;
          chord
            .sort((a, b) => a.noteKey - b.noteKey)
            .forEach((on, i) => {
              if (i === 0) return;
              on.tick += i * step;
              changed++;
            });
        }
      }

      // Let ring: each note sounds until the same key is played again (or a few beats).
      if (value.letRing) {
        const starts = new Map<string, number[]>();
        for (const on of ons) {
          const key = `${on.channel}:${on.noteKey}`;
          starts.set(key, [...(starts.get(key) ?? []), on.tick]);
        }
        for (const list of starts.values()) list.sort((a, b) => a - b);
        for (const off of offs) {
          const list = starts.get(`${off.channel}:${off.noteKey}`) ?? [];
          const started = [...list].reverse().find((t) => t < off.tick);
          if (started === undefined) continue;
          const nextStart = list.find((t) => t > started) ?? Infinity;
          const end = Math.min(nextStart - 1, started + LET_RING_QUARTERS * quarter);
          if (end > off.tick) {
            off.tick = end;
            changed++;
          }
        }
      }

      if (value.brush || value.letRing) midiTrack.events.sort((a, b) => a.tick - b.tick);
    }
  });
  return changed;
}
