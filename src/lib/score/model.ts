/**
 * Low-level helpers for changing alphaTab's score model: building beats, bars
 * and tracks, cloning them, and bringing the model back into a consistent
 * state after a change ({@link refinish}).
 *
 * Invariants the editor keeps (alphaTab relies on them):
 * - every bar of a staff has the same number of voices;
 * - every voice has at least one beat (an "empty" beat when nothing is written).
 */
import { model, Settings } from "@coderline/alphatab";

import { drumOutputKey } from "@/lib/score/drum-map";
import { reflowLyrics } from "@/lib/score/lyrics";
import { barRests, NO_TUPLET, type Duration, type Tuplet } from "@/lib/score/music";

export type Score = model.Score;
export type Track = model.Track;
export type Staff = model.Staff;
export type MasterBar = model.MasterBar;
export type Bar = model.Bar;
export type Voice = model.Voice;
export type Beat = model.Beat;
export type Note = model.Note;

const { Duration: D, AutomationType, SlideOutType } = model;

let finishSettings: Settings | null = null;

/** Clears links alphaTab derives between notes, so removed notes can't linger. */
function resetNoteLinks(note: Note) {
  note.tieOrigin = null;
  note.tieDestination = null;
  note.hammerPullOrigin = null;
  note.hammerPullDestination = null;
  note.slideOrigin = null;
  if (note.slideOutType === SlideOutType.Shift || note.slideOutType === SlideOutType.Legato) {
    note.slideTarget = null;
  }
  note.bendOrigin = null;
  note.letRingDestination = null;
  note.palmMuteDestination = null;
  note.isEffectSlurOrigin = false;
  note.hasEffectSlur = false;
  note.effectSlurOrigin = null;
  note.effectSlurDestination = null;
  // Internal in alphaTab's typings: the slur object drawn for effect slurs.
  (note as unknown as { effectSlur: unknown }).effectSlur = null;
}

/**
 * Re-links the whole model (indexes, parents, neighbours) and lets alphaTab
 * recompute everything it derives (timing, ties, tuplet groups...), then puts
 * the lyrics back on the notes. Called after every change, and after undo and
 * redo. It is idempotent: a score that was not changed comes out the same.
 */
export function refinish(score: Score): void {
  const masterBars = score.masterBars;
  masterBars.forEach((masterBar, index) => {
    const previous = masterBars[index - 1] ?? null;
    masterBar.index = index;
    masterBar.score = score;
    masterBar.previousMasterBar = previous;
    masterBar.nextMasterBar = masterBars[index + 1] ?? null;
    masterBar.start = previous
      ? previous.start + (previous.isAnacrusis ? 0 : previous.calculateDuration())
      : 0;
  });
  score.rebuildRepeatGroups();

  score.tracks.forEach((track, trackIndex) => {
    track.index = trackIndex;
    track.score = score;
    track.staves.forEach((staff, staffIndex) => {
      staff.index = staffIndex;
      staff.track = track;
      staff.bars.forEach((bar, barIndex) => {
        bar.index = barIndex;
        bar.staff = staff;
        bar.previousBar = staff.bars[barIndex - 1] ?? null;
        bar.nextBar = staff.bars[barIndex + 1] ?? null;
        bar.voices.forEach((voice, voiceIndex) => {
          voice.index = voiceIndex;
          voice.bar = bar;
          voice.beats.forEach((beat, beatIndex) => {
            beat.index = beatIndex;
            beat.voice = voice;
            beat.previousBeat = null;
            beat.nextBeat = null;
            beat.tupletGroup = null;
            beat.isEffectSlurOrigin = false;
            beat.effectSlurOrigin = null;
            beat.effectSlurDestination = null;
            beat.noteValueLookup.clear();
            beat.noteStringLookup.clear();
            beat.notes.forEach((note, noteIndex) => {
              note.index = noteIndex;
              note.beat = beat;
              if (note.isStringed) beat.noteStringLookup.set(note.string, note);
              resetNoteLinks(note);
            });
          });
        });
      });
    });
  });

  score.finish((finishSettings ??= new Settings()));
  for (const track of score.tracks) reflowLyrics(track);
}

/** Everything a bar's content consists of: for snapshots before and after an edit. */
export function* barContent(bar: Bar): Generator<object> {
  yield bar;
  for (const voice of bar.voices) {
    yield voice;
    for (const beat of voice.beats) {
      yield beat;
      yield* beat.notes;
    }
  }
}

export function* staffContent(staff: Staff): Generator<object> {
  yield staff;
  yield staff.stringTuning;
  for (const bar of staff.bars) yield* barContent(bar);
}

/**
 * Master bars `from`–`to` (inclusive) and every track's bars there, with
 * their content: for edits to the song's structure (time and key signatures,
 * repeats, tempo...).
 */
export function* masterBarContent(score: Score, from: number, to = from): Generator<object> {
  for (let index = from; index <= to; index++) {
    const masterBar = score.masterBars[index];
    if (!masterBar) continue;
    yield masterBar;
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        const bar = staff.bars[index];
        if (bar) yield* barContent(bar);
      }
    }
  }
}

export function* trackContent(track: Track): Generator<object> {
  yield track;
  yield track.playbackInfo;
  for (const staff of track.staves) yield* staffContent(staff);
}

/** A beat of the given length. It is a rest until notes are added. */
export function newBeat(duration: Duration, dots = 0, tuplet: Tuplet = NO_TUPLET): Beat {
  const beat = new model.Beat();
  beat.duration = duration;
  beat.dots = dots;
  beat.tupletNumerator = tuplet.numerator;
  beat.tupletDenominator = tuplet.denominator;
  return beat;
}

/** An invisible beat: how Guitar Pro stores a voice with nothing written. */
export function emptyBeat(): Beat {
  const beat = newBeat(D.Whole);
  beat.isEmpty = true;
  return beat;
}

export function newVoice(beats: Beat[]): Voice {
  const voice = new model.Voice();
  for (const beat of beats) voice.addBeat(beat);
  return voice;
}

/** Rests filling a bar (voice 1), or an empty beat (other voices). */
export function placeholderBeats(masterBar: MasterBar, voiceIndex: number): Beat[] {
  if (voiceIndex > 0) return [emptyBeat()];
  return barRests(masterBar.timeSignatureNumerator, masterBar.timeSignatureDenominator).map((r) =>
    newBeat(r.duration, r.dots),
  );
}

/** True when a voice holds nothing but its placeholder (empty beats or bar rests). */
export function isPlaceholderVoice(voice: Voice): boolean {
  return voice.beats.every((beat) => beat.isEmpty || beat.notes.length === 0);
}

/** A new, empty bar shaped like `template` (clef, key, number of voices). */
export function newBar(template: Bar, masterBar: MasterBar): Bar {
  const bar = new model.Bar();
  bar.clef = template.clef;
  bar.clefOttava = template.clefOttava;
  bar.keySignature = template.keySignature;
  bar.keySignatureType = template.keySignatureType;
  const voiceCount = Math.max(1, template.voices.length);
  for (let v = 0; v < voiceCount; v++) bar.addVoice(newVoice(placeholderBeats(masterBar, v)));
  return bar;
}

/** Appends a bar at the end of the song, in every track, like the last one. */
export function appendMasterBar(score: Score): MasterBar {
  const last = score.masterBars.at(-1)!;
  const masterBar = new model.MasterBar();
  masterBar.timeSignatureNumerator = last.timeSignatureNumerator;
  masterBar.timeSignatureDenominator = last.timeSignatureDenominator;
  masterBar.timeSignatureCommon = last.timeSignatureCommon;
  masterBar.tripletFeel = last.tripletFeel;
  score.addMasterBar(masterBar);
  for (const track of score.tracks) {
    for (const staff of track.staves) staff.addBar(newBar(staff.bars.at(-1)!, masterBar));
  }
  return masterBar;
}

/**
 * Inserts an empty bar at `index` in every track. Its time signature and triplet feel are those
 * of the bar `like`; every track's new bar is shaped like that track's bar there (clef, key,
 * voices). Repeats, sections and tempo changes stay with the bars they belong to.
 */
export function insertMasterBar(score: Score, index: number, like: number): MasterBar {
  const reference = score.masterBars[like]!;
  const masterBar = new model.MasterBar();
  masterBar.timeSignatureNumerator = reference.timeSignatureNumerator;
  masterBar.timeSignatureDenominator = reference.timeSignatureDenominator;
  masterBar.timeSignatureCommon = reference.timeSignatureCommon;
  masterBar.tripletFeel = reference.tripletFeel;
  masterBar.score = score;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      staff.bars.splice(index, 0, newBar(staff.bars[like]!, masterBar));
    }
  }
  score.masterBars.splice(index, 0, masterBar);
  return masterBar;
}

/**
 * Removes the bar at `index` from every track. A tempo change on it moves to the next bar when
 * that has none, so the tempo does not fall back to the default (the song's first bar holds
 * the starting tempo). The song keeps at least one bar: call this only with two or more.
 */
export function removeMasterBar(score: Score, index: number): void {
  const [removed] = score.masterBars.splice(index, 1);
  for (const track of score.tracks) {
    for (const staff of track.staves) staff.bars.splice(index, 1);
  }
  const next = score.masterBars[index];
  if (
    removed &&
    next &&
    removed.tempoAutomations.length > 0 &&
    next.tempoAutomations.length === 0
  ) {
    next.tempoAutomations = [...removed.tempoAutomations];
  }
}

/** Makes sure every bar of the staff has at least `count` voices. */
export function ensureVoices(staff: Staff, count: number): void {
  for (const bar of staff.bars) {
    while (bar.voices.length < count) {
      bar.addVoice(newVoice(placeholderBeats(bar.masterBar, bar.voices.length)));
    }
  }
}

/** The staff's tuning, highest string first. Empty for drums and keyboards. */
export const tuningOf = (staff: Staff): number[] => staff.stringTuning.tunings;

/**
 * The drum number of a note, as Guitar Pro shows it: the output key of one of
 * the track's own articulations (Guitar Pro 6+ files), or the id of one of the
 * default ones (e.g. 92 "Hi-Hat (half)").
 */
export function drumNumber(note: Note): number {
  const articulations = note.beat.voice.bar.staff.track.percussionArticulations;
  return (
    articulations[note.percussionArticulation]?.outputMidiNumber ?? note.percussionArticulation
  );
}

/** The MIDI key a drum note sounds (92 "Hi-Hat (half)" plays 46, as alphaTab does). */
export function drumKey(note: Note): number {
  const articulations = note.beat.voice.bar.staff.track.percussionArticulations;
  return (
    articulations[note.percussionArticulation]?.outputMidiNumber ??
    drumOutputKey(note.percussionArticulation)
  );
}

/** What a note sounds like: its MIDI pitch, or its drum's General MIDI key. */
export const soundOf = (note: Note): number => (note.isPercussion ? drumKey(note) : note.realValue);

/** Whether the staff is written as tablature (it has strings). */
export const isStringed = (staff: Staff) => !staff.isPercussion && tuningOf(staff).length > 0;

const MODEL_TYPES = [
  model.Score,
  model.Track,
  model.Staff,
  model.MasterBar,
  model.Bar,
  model.Voice,
  model.Beat,
  model.Note,
  model.TupletGroup,
  model.GraceGroup,
];

const isModelObject = (value: unknown) => MODEL_TYPES.some((Type) => value instanceof Type);

/**
 * Copies the source's own properties onto `target`, except links to other
 * model objects and lookup maps/sets (the new object keeps its own).
 */
function copyProps<T extends object>(target: T, source: T, skip: readonly string[]) {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (skip.includes(key) || isModelObject(value)) continue;
    if (value instanceof Map || value instanceof Set) continue;
    record[key] = Array.isArray(value) ? [...value] : value;
  }
}

const clonePoints = (points: model.BendPoint[] | null) =>
  points?.map((point) => new model.BendPoint(point.offset, point.value)) ?? null;

/** The highest (or lowest) of `points`, as alphaTab tracks it for drawing. */
function extremePoint(points: model.BendPoint[] | null, pick: (a: number, b: number) => boolean) {
  return (points ?? []).reduce<model.BendPoint | null>(
    (best, point) => (!best || pick(point.value, best.value) ? point : best),
    null,
  );
}

export function cloneNote(note: Note): Note {
  const copy = new model.Note();
  copyProps(copy, note, ["id", "index", "_noteIdBag", "effectSlur"]);
  // Bend points are objects: the copy gets its own.
  copy.bendPoints = clonePoints(note.bendPoints);
  copy.maxBendPoint = extremePoint(copy.bendPoints, (a, b) => a > b);
  return copy;
}

/** A detached copy of a beat and its notes, with new ids. */
export function cloneBeat(beat: Beat): Beat {
  const copy = new model.Beat();
  copyProps(copy, beat, ["id", "index", "notes"]);
  copy.whammyBarPoints = clonePoints(beat.whammyBarPoints);
  copy.maxWhammyPoint = extremePoint(copy.whammyBarPoints, (a, b) => a > b);
  copy.minWhammyPoint = extremePoint(copy.whammyBarPoints, (a, b) => a < b);
  if (beat.tremoloPicking) {
    copy.tremoloPicking = Object.assign(new model.TremoloPickingEffect(), beat.tremoloPicking);
  }
  // Automations (tempo, instrument changes) are objects: the copy gets its own, so changing the
  // program of a copied track does not change the original's.
  copy.automations = beat.automations.map((automation) =>
    Object.assign(new model.Automation(), automation),
  );
  for (const note of beat.notes) copy.addNote(cloneNote(note));
  return copy;
}

function cloneBar(bar: Bar): Bar {
  const copy = new model.Bar();
  copyProps(copy, bar, ["id", "index", "voices", "sustainPedals"]);
  for (const voice of bar.voices) {
    const voiceCopy = new model.Voice();
    for (const beat of voice.beats) voiceCopy.addBeat(cloneBeat(beat));
    copy.addVoice(voiceCopy);
  }
  for (const marker of bar.sustainPedals) {
    const markerCopy = Object.assign(new model.SustainPedalMarker(), marker);
    markerCopy.bar = copy;
    markerCopy.previousPedalMarker = null;
    markerCopy.nextPedalMarker = null;
    copy.sustainPedals.push(markerCopy);
  }
  return copy;
}

/** A detached copy of a whole track (not yet added to the score). */
export function cloneTrack(track: Track): Track {
  const copy = new model.Track();
  copyProps(copy, track, ["index", "staves", "playbackInfo"]);
  Object.assign(copy.playbackInfo, track.playbackInfo);
  for (const staff of track.staves) {
    const staffCopy = new model.Staff();
    copyProps(staffCopy, staff, ["index", "bars", "stringTuning"]);
    staffCopy.stringTuning = new model.Tuning(
      staff.stringTuning.name,
      [...staff.stringTuning.tunings],
      staff.stringTuning.isStandard,
    );
    for (const [id, chord] of staff.chords ?? []) staffCopy.addChord(id, chord);
    for (const bar of staff.bars) staffCopy.addBar(cloneBar(bar));
    copy.addStaff(staffCopy);
  }
  return copy;
}

/**
 * Sets the track's General MIDI program, including the instrument change
 * alphaTab adds to the first beat (which the MIDI export plays).
 */
export function setProgram(track: Track, program: number): void {
  track.playbackInfo.program = program;
  const firstBeat = track.staves[0]?.bars[0]?.voices[0]?.beats[0];
  const automation = firstBeat?.getAutomation(AutomationType.Instrument);
  if (automation && automation.ratioPosition === 0) automation.value = program;
}

/** Melodic MIDI channels (9 is reserved for drums). */
const MELODIC_CHANNELS = Array.from({ length: 16 }, (_, i) => i).filter((c) => c !== 9);

/**
 * MIDI channels for a new track: unused ones first. When all are taken (more
 * than seven melodic tracks with two channels each), channels are shared, as
 * in Guitar Pro.
 */
export function freeChannels(score: Score, count: number): number[] {
  const used = new Set<number>();
  for (const track of score.tracks) {
    used.add(track.playbackInfo.primaryChannel);
    used.add(track.playbackInfo.secondaryChannel);
  }
  const free = MELODIC_CHANNELS.filter((channel) => !used.has(channel)).slice(0, count);
  for (let i = 0; free.length < count; i++)
    free.push(MELODIC_CHANNELS[i % MELODIC_CHANNELS.length]!);
  return free;
}
