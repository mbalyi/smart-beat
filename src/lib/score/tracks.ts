/**
 * Track and instrument management: new songs, adding, removing, reordering
 * and duplicating tracks, and their instrument, tuning and capo.
 *
 * These functions only change the model. The workspace runs them through
 * {@link ScoreEditor.run} so they can be undone, and the editor re-finishes
 * the score afterwards.
 */
import { importer, model, Settings } from "@coderline/alphatab";

import {
  cloneTrack,
  freeChannels,
  isStringed,
  newVoice,
  placeholderBeats,
  refinish,
  setProgram,
  tuningOf,
  type Score,
  type Staff,
  type Track,
} from "@/lib/score/model";
import { adoptLyrics } from "@/lib/score/lyrics";
import { MAX_CAPO, type InstrumentPreset, type TrackKind } from "@/lib/score/music";
import { adoptTrack, rememberMix, trackMix } from "@/lib/score/score";

const { Clef, Ottavia } = model;

/** Guitar Pro's default track volume (13 of 16), for new tracks. */
const NEW_TRACK_VOLUME = 13;

/** General MIDI programs written in bass clef. */
const BASS_CLEF_PROGRAMS = new Set([32, 33, 34, 35, 36, 37, 38, 39, 42, 43, 57, 58, 67, 70]);

export interface NewTrack {
  kind: TrackKind;
  name: string;
  program: number;
  /** Stringed tracks: MIDI pitches, highest string first. */
  tuning?: number[];
}

export const trackFromPreset = (preset: InstrumentPreset): NewTrack => ({
  kind: preset.kind,
  name: preset.name,
  program: preset.program,
  tuning: preset.tuning ? [...preset.tuning] : undefined,
});

function clefFor(track: NewTrack): model.Clef {
  // Extended-range guitars stay in treble clef; basses and low instruments use bass clef.
  if (track.kind === "drums") return Clef.Neutral;
  return BASS_CLEF_PROGRAMS.has(track.program) ? Clef.F4 : Clef.G2;
}

/** A unique name: "Guitar", then "Guitar 2", "Guitar 3"... */
export function uniqueTrackName(score: Score, name: string): string {
  const taken = new Set(score.tracks.map((t) => t.name.trim()));
  const base = name.trim() || "Track";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Builds a track with one empty bar per bar of the song (not yet added). */
export function createTrack(score: Score, spec: NewTrack): Track {
  const track = new model.Track();
  track.name = spec.name;
  track.shortName = spec.name.slice(0, 10);
  const staff = new model.Staff();
  track.addStaff(staff);

  const info = track.playbackInfo;
  info.volume = NEW_TRACK_VOLUME;
  info.balance = 8;
  if (spec.kind === "drums") {
    staff.isPercussion = true;
    staff.showTablature = false;
    staff.showStandardNotation = true;
    info.program = 0;
    info.primaryChannel = 9;
    info.secondaryChannel = 9;
  } else {
    const [primary, secondary] = freeChannels(score, 2);
    info.primaryChannel = primary!;
    info.secondaryChannel = secondary!;
    info.program = spec.program;
    if (spec.kind === "stringed") {
      staff.stringTuning = new model.Tuning("", [...(spec.tuning ?? [])], false);
      staff.stringTuning.finish();
      staff.showTablature = true;
      staff.showStandardNotation = true;
      // Guitars and basses are written an octave above how they sound.
      staff.displayTranspositionPitch = -12;
    } else {
      staff.showTablature = false;
      staff.showStandardNotation = true;
    }
  }

  const clef = clefFor(spec);
  const reference = score.tracks[0]?.staves[0];
  for (const masterBar of score.masterBars) {
    const bar = new model.Bar();
    bar.clef = clef;
    bar.clefOttava = Ottavia.Regular;
    const template = reference?.bars[masterBar.index];
    if (template) {
      bar.keySignature = template.keySignature;
      bar.keySignatureType = template.keySignatureType;
    }
    staff.addBar(bar);
    bar.addVoice(newVoice(placeholderBeats(masterBar, 0)));
  }
  adoptTrack(track);
  adoptLyrics(track);
  return track;
}

/** Inserts a track (at the end by default). */
export function insertTrack(score: Score, track: Track, index = score.tracks.length): void {
  track.score = score;
  score.tracks.splice(index, 0, track);
}

export function removeTrack(score: Score, index: number): void {
  if (score.tracks.length <= 1) throw new Error("A song needs at least one track.");
  score.tracks.splice(index, 1);
}

export function moveTrack(score: Score, from: number, to: number): void {
  const [track] = score.tracks.splice(from, 1);
  if (track) score.tracks.splice(to, 0, track);
}

/** Copies a track right after the original, with its own MIDI channels. */
export function duplicateTrack(score: Score, index: number): Track {
  const original = score.tracks[index]!;
  const copy = cloneTrack(original);
  copy.name = uniqueTrackName(score, original.name);
  copy.shortName = copy.name.slice(0, 10);
  if (!original.isPercussion) {
    const [primary, secondary] = freeChannels(score, 2);
    copy.playbackInfo.primaryChannel = primary!;
    copy.playbackInfo.secondaryChannel = secondary!;
  }
  rememberMix(copy, trackMix(original));
  insertTrack(score, copy, index + 1);
  return copy;
}

export function renameTrack(track: Track, name: string): void {
  track.name = name.trim() || track.name;
  track.shortName = track.name.slice(0, 10);
}

export function setInstrument(track: Track, program: number): void {
  if (!track.isPercussion) setProgram(track, program);
}

/**
 * Changes a stringed track's tuning. Strings are added or removed at the low
 * end (a 7th string is a low B), so notes stay on their strings and keep
 * their fret numbers; notes on removed strings are deleted. Returns how many.
 */
export function setTuning(staff: Staff, tuning: number[]): number {
  if (!isStringed(staff) || tuning.length === 0) return 0;
  const delta = tuning.length - tuningOf(staff).length;
  let removed = 0;
  if (delta !== 0) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of [...beat.notes]) {
            if (!note.isStringed) continue;
            const string = note.string + delta;
            if (string < 1) {
              beat.removeNote(note);
              removed++;
            } else {
              note.string = string;
            }
          }
        }
      }
    }
  }
  staff.stringTuning = new model.Tuning("", [...tuning], false);
  staff.stringTuning.finish();
  return removed;
}

export function setCapo(staff: Staff, capo: number): void {
  staff.capo = Math.min(MAX_CAPO, Math.max(0, Math.round(capo)));
}

/** A new, empty song: one steel-string guitar, 4/4 at 120 BPM, four bars. */
export function createSong(): Score {
  const tex = String.raw`
\title "Untitled"
\tempo 120
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  r.1 | r.1 | r.1 | r.1
`;
  const score = importer.ScoreLoader.loadAlphaTex(tex, new Settings());
  score.title = "";
  for (const track of score.tracks) {
    track.playbackInfo.volume = NEW_TRACK_VOLUME;
    adoptTrack(track);
    adoptLyrics(track);
  }
  refinish(score);
  return score;
}
