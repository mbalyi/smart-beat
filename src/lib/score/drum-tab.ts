/**
 * Drum tablature, Guitar Pro style: six lines, every hit written as its drum
 * number (35 kick, 38 snare, 42 closed hi-hat…, the Virtual Drumkit numbers of
 * `drum-map.ts`), ghost notes in parentheses.
 *
 * alphaTab cannot draw tablature for a percussion staff, so the drum track
 * gets a second, "mirror" staff while the drum tab is shown: an ordinary tab
 * staff whose six strings are tuned to MIDI note 0. A hit on a string at fret
 * N then sounds exactly like the drum note N, so the mirror's notes duplicate
 * the drum notes in the generated MIDI and are removed there
 * ({@link removeMirrorNotes}). alphaTab draws, aligns, wraps, prints and moves
 * the cursor over the mirror like any tab staff.
 *
 * The mirror only exists while a drum track is shown with tab. It is rebuilt
 * from the drum staff before every render, and never saved, exported or
 * recorded in undo snapshots ({@link realStaves}, {@link withoutDrumTabs}).
 */
import { midi, model } from "@coderline/alphatab";

import {
  drumKey,
  refinish,
  type Beat,
  type Note,
  type Score,
  type Staff,
  type Track,
} from "@/lib/score/model";

/** Lines of the drum tab (alphaTab strings, 1 = bottom line). */
export const DRUM_TAB_STRINGS = 6;

const IS_MIRROR = new WeakSet<Staff>();

export const isMirrorStaff = (staff: Staff): boolean => IS_MIRROR.has(staff);

/** A track's staves without the drum-tab mirror. */
export const realStaves = (track: Track): Staff[] => track.staves.filter((s) => !IS_MIRROR.has(s));

const CYMBALS = new Set([
  29, 30, 42, 46, 49, 51, 52, 53, 55, 57, 59, 92, 93, 94, 95, 96, 97, 98, 126, 127,
]);
const HIGH_TOMS = new Set([47, 48, 50]);
const SNARES = new Set([31, 37, 38, 39, 40, 91]);
const LOW_TOMS = new Set([41, 43, 45]);
const KICKS = new Set([35, 36, 114]);

/**
 * The line a drum is written on, top to bottom: cymbals and hi-hat, high and
 * mid toms, snare, low and floor toms, kick, then pedal hi-hat and the rest.
 * Returned as an alphaTab string number (6 = top line).
 */
export function drumTabString(drum: number): number {
  if (CYMBALS.has(drum)) return 6;
  if (HIGH_TOMS.has(drum)) return 5;
  if (SNARES.has(drum)) return 4;
  if (LOW_TOMS.has(drum)) return 3;
  if (KICKS.has(drum)) return 2;
  return 1;
}

/** The free line nearest to `wanted` (top first on a tie), or null if all are taken. */
function freeString(wanted: number, taken: Set<number>): number | null {
  for (let distance = 0; distance < DRUM_TAB_STRINGS; distance++) {
    for (const candidate of [wanted + distance, wanted - distance]) {
      if (candidate >= 1 && candidate <= DRUM_TAB_STRINGS && !taken.has(candidate))
        return candidate;
    }
  }
  return null;
}

function mirrorNote(source: Note, string: number): Note {
  const note = new model.Note();
  note.string = string;
  note.fret = drumKey(source);
  note.isGhost = source.isGhost;
  note.isDead = false;
  note.accentuated = source.accentuated;
  note.dynamics = source.dynamics;
  note.isStaccato = source.isStaccato;
  return note;
}

function mirrorBeat(source: Beat): Beat {
  const beat = new model.Beat();
  beat.duration = source.duration;
  beat.dots = source.dots;
  beat.tupletNumerator = source.tupletNumerator;
  beat.tupletDenominator = source.tupletDenominator;
  beat.isEmpty = source.isEmpty;
  beat.graceType = source.graceType;
  beat.dynamics = source.dynamics;
  // Hits go top to bottom so that cymbals keep the top line.
  const taken = new Set<number>();
  const notes = [...source.notes].sort(
    (a, b) => drumTabString(drumKey(b)) - drumTabString(drumKey(a)),
  );
  for (const note of notes) {
    const string = freeString(drumTabString(drumKey(note)), taken);
    if (string === null) continue; // more than six hits at once
    taken.add(string);
    beat.addNote(mirrorNote(note, string));
  }
  return beat;
}

/** The tab staff mirroring a drum staff (not yet added to the track). */
export function buildMirror(drums: Staff): Staff {
  const staff = new model.Staff();
  staff.isPercussion = false;
  staff.stringTuning.tunings = Array.from({ length: DRUM_TAB_STRINGS }, () => 0);
  staff.showTablature = true;
  staff.showStandardNotation = false;
  for (const sourceBar of drums.bars) {
    const bar = new model.Bar();
    bar.clef = model.Clef.Neutral;
    for (const sourceVoice of sourceBar.voices) {
      const voice = new model.Voice();
      for (const sourceBeat of sourceVoice.beats) voice.addBeat(mirrorBeat(sourceBeat));
      bar.addVoice(voice);
    }
    staff.addBar(bar);
  }
  IS_MIRROR.add(staff);
  return staff;
}

/** Removes every mirror staff from the score. Returns whether there was one. */
function detachMirrors(score: Score): boolean {
  let removed = false;
  for (const track of score.tracks) {
    const kept = realStaves(track);
    if (kept.length !== track.staves.length) {
      track.staves = kept;
      removed = true;
    }
  }
  return removed;
}

/**
 * Shows (`true`) or hides the drum tab of a drum track: rebuilds the mirror
 * from the drum staff (after edits too), or removes it. Any other track's
 * mirror is removed. Re-links the model afterwards.
 */
export function setDrumTab(score: Score, track: Track, shown: boolean): void {
  detachMirrors(score);
  const drums = track.staves[0];
  if (shown && drums?.isPercussion) {
    track.addStaff(buildMirror(drums));
  }
  refinish(score);
}

/** The drum track's mirror staff, if the drum tab is shown. */
export const mirrorOf = (track: Track): Staff | null =>
  track.staves.find((staff) => IS_MIRROR.has(staff)) ?? null;

/**
 * Runs `fn` (saving, exporting, snapshots) on the score without its mirror
 * staves, then puts them back.
 */
export function withoutDrumTabs<T>(score: Score, fn: () => T): T {
  const mirrors = score.tracks.map((track) => mirrorOf(track));
  if (!mirrors.some(Boolean)) return fn();
  for (const track of score.tracks) track.staves = realStaves(track);
  try {
    return fn();
  } finally {
    score.tracks.forEach((track, i) => {
      const mirror = mirrors[i];
      if (mirror) track.staves = [...track.staves, mirror];
    });
  }
}

/** The beat of the mirror staff at the same place as a drum beat (and back). */
function counterpart(beat: Beat, toMirror: boolean): Beat | null {
  const bar = beat.voice.bar;
  const track = bar.staff.track;
  const staff = toMirror ? mirrorOf(track) : realStaves(track)[0];
  return staff?.bars[bar.index]?.voices[beat.voice.index]?.beats[beat.index] ?? null;
}

/** The mirror's beat for a drum beat (null when the drum tab is not shown). */
export const mirrorBeatOf = (beat: Beat): Beat | null => {
  const staff = beat.voice?.bar?.staff;
  if (!staff) return null;
  return isMirrorStaff(staff) ? beat : counterpart(beat, true);
};

/** The drum beat for a beat of the mirror (any other beat is returned as is). */
export const realBeatOf = (beat: Beat): Beat => {
  const staff = beat.voice?.bar?.staff;
  return staff && isMirrorStaff(staff) ? (counterpart(beat, false) ?? beat) : beat;
};

/** The drum note a note of the mirror stands for (same drum number in the same beat). */
export function realNoteOf(note: Note): Note {
  if (!isMirrorStaff(note.beat.voice.bar.staff)) return note;
  const beat = realBeatOf(note.beat);
  return beat.notes.find((n) => drumKey(n) === note.fret) ?? note;
}

/** The mirror's note for a drum note. */
export function mirrorNoteOf(note: Note): Note | null {
  if (!note.beat) return null;
  const beat = mirrorBeatOf(note.beat);
  if (beat === note.beat) return null;
  return beat?.notes.find((n) => n.fret === drumKey(note)) ?? null;
}

/**
 * Removes the mirror's sound from alphaTab's generated MIDI: a note-on (or
 * note-off) that repeats another one on the same tick, channel and key.
 * Returns how many events were removed.
 */
export function removeMirrorNotes(file: midi.MidiFile): number {
  let removed = 0;
  for (const track of file.tracks) {
    const seen = new Set<string>();
    const events = track.events.filter((event) => {
      const on = event instanceof midi.NoteOnEvent;
      if (!on && !(event instanceof midi.NoteOffEvent)) return true;
      const key = `${on ? "on" : "off"}:${event.tick}:${event.channel}:${event.noteKey}`;
      if (seen.has(key)) {
        removed++;
        return false;
      }
      seen.add(key);
      return true;
    });
    if (events.length !== track.events.length) {
      track.events.length = 0;
      track.events.push(...events);
    }
  }
  // `file.events` reads the tracks' events, so nothing else needs updating.
  return removed;
}
