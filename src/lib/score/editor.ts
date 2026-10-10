/**
 * The score editor: an edit cursor and selection on one track, and the
 * commands that write music (notes, rests, durations, ties, tuplets, voices,
 * clipboard), with unlimited undo and redo.
 *
 * Like Guitar Pro 5, bars may hold more or less than their time signature
 * allows; the editor never moves music between bars on its own.
 *
 * The editor changes alphaTab's model directly and calls {@link refinish}
 * after every change. Listeners (the workspace) then re-render and regenerate
 * the MIDI.
 */
import { track, type TrackedEvent } from "@/lib/telemetry";
import { model } from "@coderline/alphatab";

import { restsFor } from "@/lib/score/bar-duration";
import { chordOf, setChord, type ChordSpec } from "@/lib/score/chords";
import {
  activeEffectName,
  BEAT_EFFECTS,
  bendOf,
  effectAvailable,
  effectOff,
  effectText,
  harmonicValue,
  NOTE_EFFECTS,
  setBend,
  setWhammy,
  unavailableText,
  whammyOf,
  type BeatEffectId,
  type CurvePoint,
  type Effect,
  type NoteEffectId,
} from "@/lib/score/effects";
import { History } from "@/lib/score/history";
import { keyAlteration } from "@/lib/score/keys";
import {
  appendMasterBar,
  barContent,
  cloneBeat,
  cloneNote,
  ensureVoices,
  isStringed,
  masterBarContent,
  newBeat,
  placeholderBeats,
  refinish,
  drumNumber,
  staffContent,
  tuningOf,
  type Bar,
  type Beat,
  type Note,
  type Score,
  type Staff,
  type Track,
  type Voice,
} from "@/lib/score/model";
import { DRUM_MIDI_MAP, drumNumberName } from "@/lib/score/drum-map";
import { DRUM_TAB_LINES, drumLine, setDrumLine } from "@/lib/score/drum-lines";
import { drumTabString, placeDrums } from "@/lib/score/drum-tab";
import {
  MAX_FRET,
  NO_TUPLET,
  noteValueLabel,
  pitchFromLetter,
  pitchName,
  stepDuration,
  type Duration,
  type TrackKind,
  type Tuplet,
} from "@/lib/score/music";

const { Duration: D, GraceType } = model;

/** Where the cursor is. `string` is alphaTab's (1 = lowest string). */
export interface Cursor {
  track: number;
  /** 0 = voice 1, 1 = voice 2. */
  voice: number;
  bar: number;
  beat: number;
  /** Stringed tracks: the string the cursor is on (1 = lowest). */
  string: number;
  /** Pitched and drum tracks: the selected note (pitch or drum sound), if any. */
  pitch: number | null;
}

export interface BeatPosition {
  bar: number;
  beat: number;
}

export interface Selection {
  /** Where the selection started (stays put while it is extended). */
  anchor: BeatPosition;
  /** Where it ends (moves with the cursor). */
  head: BeatPosition;
}

export const MAX_VOICES = 2;

/** How long after a digit a second digit makes a two-digit fret (as in Guitar Pro). */
export const TWO_DIGIT_MS = 1000;
/** Digits of a drum number ("4", "6") typed within this time belong together. */
export const DRUM_DIGITS_MS = 1200;

export function comparePositions(a: BeatPosition, b: BeatPosition): number {
  return a.bar - b.bar || a.beat - b.beat;
}

/** The selection's first and last beat, in song order. */
export function selectionRange(selection: Selection): [BeatPosition, BeatPosition] {
  return comparePositions(selection.anchor, selection.head) <= 0
    ? [selection.anchor, selection.head]
    : [selection.head, selection.anchor];
}

export function trackKind(track: Track): TrackKind {
  const staff = track.staves[0]!;
  if (staff.isPercussion || track.isPercussion) return "drums";
  return isStringed(staff) ? "stringed" : "pitched";
}

/** What the note under the cursor sounds like, for the status line and views. */
export interface NoteInfo {
  string: number | null;
  fret: number | null;
  /** MIDI pitch; for drums, the drum sound (articulation). */
  pitch: number;
  tied: boolean;
}

export interface BeatInfo {
  duration: Duration;
  dots: number;
  tuplet: Tuplet;
  /** A rest (no notes), including the placeholder of an empty bar. */
  rest: boolean;
  notes: NoteInfo[];
}

/** The effects at the cursor (or on the selection), for the toolbar and menus. */
export interface EffectsInfo {
  /** Note effects of the note under the cursor (null: no note there). */
  note: Record<NoteEffectId, number> | null;
  /** Beat effects of the cursor's beat (null: no notes there). */
  beat: Record<BeatEffectId, number> | null;
  bend: CurvePoint[] | null;
  whammy: CurvePoint[] | null;
  /** How the cursor's beat is a grace note (alphaTab's GraceType; 0 = not). */
  grace: number;
  /** Free text on the cursor's beat. */
  text: string | null;
  chord: ChordSpec | null;
}

/** A copied beat, with the sounding pitch of each note (a detached note can't compute it). */
interface CopiedBeat {
  beat: Beat;
  pitches: number[];
}

interface Clipboard {
  kind: TrackKind;
  /** Copied beats, one list per bar they came from. */
  bars: CopiedBeat[][];
}

interface HistoryExtra {
  cursor: Cursor;
  selection: Selection | null;
}

export type EditorChange = "model" | "cursor";

/** An empty voice's stand-in: an invisible beat, or the rest filling an empty bar. */
function isPlaceholder(beat: Beat): boolean {
  return beat.isEmpty || (beat.notes.length === 0 && beat.voice.beats.length === 1);
}

/** Which note of a chord is "under the cursor" on a pitched or drum track. */
/** A note's pitch, or a drum note's number as Guitar Pro shows it (92, not the 46 it plays). */
const pitchOf = (note: Note): number => (note.isPercussion ? drumNumber(note) : note.realValue);

const graceText = (type: model.GraceType) =>
  type === GraceType.OnBeat ? "Grace note on the beat" : "Grace note before the beat";

/** Changes a tab note's fret; a natural harmonic moves along (it rings at the fret played). */
function setNoteFret(note: Note, fret: number) {
  note.fret = fret;
  if (note.harmonicType === model.HarmonicType.Natural) note.harmonicValue = harmonicValue(fret);
}

/** A palette button's state: set on every target, on some, or on none (#53). */
export type ToggleState = "on" | "off" | "mixed";

export function stateOf(flags: readonly boolean[]): ToggleState {
  if (flags.length === 0 || flags.every((f) => !f)) return "off";
  return flags.every(Boolean) ? "on" : "mixed";
}

/** A new note at the same place (string and fret, pitch or drum sound), without effects. */
function plainNote(source: Note): Note {
  const note = new model.Note();
  if (source.isStringed) {
    note.string = source.string;
    note.fret = source.fret;
  } else if (source.isPercussion) {
    note.percussionArticulation = source.percussionArticulation;
  } else {
    note.octave = source.octave;
    note.tone = source.tone;
  }
  return note;
}

/** Edits that are counted under their own name (docs/analytics.md); every other edit is `edit`. */
const EDIT_EVENTS: Record<string, TrackedEvent> = {
  Transpose: "transpose",
  Paste: "copy_paste",
  "Add chord": "chord_insert",
  "Change chord": "chord_insert",
};

export class ScoreEditor {
  readonly score: Score;
  private readonly history = new History<HistoryExtra>();
  /** The history state that is on disk (null: the state the song was opened in). */
  private savedAt: ReturnType<History<HistoryExtra>["undo"]> = null;
  private readonly listeners = new Set<(change: EditorChange) => void>();
  private _cursor: Cursor;
  private _selection: Selection | null = null;
  private clipboard: Clipboard | null = null;
  /** Length given to notes typed into an empty bar. */
  private _entryDuration: Duration = D.Quarter;
  /** The first digit of a possible two-digit fret. */
  private pendingDigit: { digit: number; at: number; key: string } | null = null;
  /** Digits typed so far of a drum number on a drum track ("4", then "6" = 46). */
  private pendingDrum: { text: string; at: number; key: string } | null = null;
  /** After R: the next drum number typed replaces the drum under the cursor. */
  private replacingDrum = false;
  /** Increases with every change to the music (edits, undo, redo). */
  private _revision = 0;
  /** Spoken feedback for the last command ("Fret 5 on string 3"). */
  private _message = "";
  /** Increases with every change (music, cursor, selection): for React. */
  private _version = 0;

  constructor(score: Score, track = 0) {
    this.score = score;
    this._cursor = { track, voice: 0, bar: 0, beat: 0, string: 1, pitch: null };
    this._cursor.string = this.defaultString();
  }

  // --- State -----------------------------------------------------------------

  get cursor(): Readonly<Cursor> {
    return this._cursor;
  }

  get selection(): Readonly<Selection> | null {
    return this._selection;
  }

  get revision(): number {
    return this._revision;
  }

  get message(): string {
    return this._message;
  }

  get version(): number {
    return this._version;
  }

  get entryDuration(): Duration {
    return this._entryDuration;
  }

  get canUndo() {
    return this.history.canUndo;
  }

  get canRedo() {
    return this.history.canRedo;
  }

  get undoLabel() {
    return this.history.undoLabel;
  }

  get redoLabel() {
    return this.history.redoLabel;
  }

  /**
   * Whether the music differs from the last saved (or opened) state. Undoing
   * back to that state makes it false again; undoing past a save makes it true.
   */
  get edited(): boolean {
    return this.history.top !== this.savedAt;
  }

  /** Marks the current music as saved: `edited` is false until the next change. */
  markSaved() {
    this.savedAt = this.history.top;
    this.emit("cursor");
  }

  get hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  get track(): Track {
    return this.score.tracks[this._cursor.track]!;
  }

  get staff(): Staff {
    return this.track.staves[0]!;
  }

  get kind(): TrackKind {
    return trackKind(this.track);
  }

  get stringCount(): number {
    return isStringed(this.staff) ? tuningOf(this.staff).length : 0;
  }

  /**
   * Called with the sounding pitch of every note entered or changed on a pitched track (fret,
   * keyboard, staff or typed digit), so the app can preview it (#90). Not set: silent.
   */
  private noteEntered: ((pitch: number) => void) | null = null;

  /** Sets (or, with null, clears) the listener of {@link noteEntered}. */
  onNoteEntered(listener: ((pitch: number) => void) | null) {
    this.noteEntered = listener;
  }

  subscribe = (listener: (change: EditorChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(change: EditorChange) {
    this._version++;
    for (const listener of this.listeners) listener(change);
  }

  private bar(index = this._cursor.bar): Bar {
    return this.staff.bars[index]!;
  }

  /** The voice at the cursor, or null where voice 2 has not been written yet. */
  private voice(bar = this._cursor.bar, voice = this._cursor.voice): Voice | null {
    return this.bar(bar).voices[voice] ?? null;
  }

  private beatAt(position: BeatPosition = this._cursor): Beat | null {
    return this.voice(position.bar)?.beats[position.beat] ?? null;
  }

  private beatCount(bar: number): number {
    return this.voice(bar)?.beats.length ?? 1;
  }

  /** The beat under the cursor, as plain data. */
  get beatInfo(): BeatInfo {
    const beat = this.beatAt();
    if (!beat || isPlaceholder(beat)) {
      // Nothing written yet: show the value the next note will get.
      return { duration: this._entryDuration, dots: 0, tuplet: NO_TUPLET, rest: true, notes: [] };
    }
    return {
      duration: beat.duration,
      dots: beat.dots,
      tuplet: beat.hasTuplet
        ? { numerator: beat.tupletNumerator, denominator: beat.tupletDenominator }
        : NO_TUPLET,
      rest: beat.notes.length === 0,
      notes: beat.notes.map((note) => ({
        string: note.isStringed ? note.string : null,
        fret: note.isStringed ? note.fret : null,
        pitch: pitchOf(note),
        tied: note.isTieDestination,
      })),
    };
  }

  /**
   * The beat the cursor is on, for drawing it. Where voice 2 hasn't been
   * written yet, the bar's first beat stands in.
   */
  cursorBeat(): Beat | null {
    return this.beatAt() ?? this.bar().voices[0]?.beats[0] ?? null;
  }

  /** The note under the cursor, if any. */
  cursorNote(): Note | null {
    return this.noteAtCursor();
  }

  /** The selected beats, in order (empty without a selection). */
  selectedBeatList(): Beat[] {
    return this._selection ? this.selectedBeats() : [];
  }

  /** The note the cursor is on: on its string (tab) or the selected pitch. */
  private noteAtCursor(beat: Beat | null = this.beatAt()): Note | null {
    if (!beat) return null;
    if (this.kind === "stringed") return beat.getNoteOnString(this._cursor.string);
    const { pitch } = this._cursor;
    return beat.notes.find((note) => pitchOf(note) === pitch) ?? null;
  }

  // --- Cursor and selection ------------------------------------------------

  private defaultString(): number {
    // Start on the top line of the tab (the highest string), as Guitar Pro does.
    return Math.max(1, this.stringCount);
  }

  /** Keeps the cursor inside the song after tracks, bars or beats change. */
  private clamp() {
    const c = this._cursor;
    c.track = Math.min(Math.max(0, c.track), this.score.tracks.length - 1);
    c.voice = Math.min(Math.max(0, c.voice), MAX_VOICES - 1);
    c.bar = Math.min(Math.max(0, c.bar), this.staff.bars.length - 1);
    c.beat = Math.min(Math.max(0, c.beat), this.beatCount(c.bar) - 1);
    const strings = this.stringCount;
    c.string = strings > 0 ? Math.min(Math.max(1, c.string), strings) : 1;
    if (this._selection) {
      const inside = (p: BeatPosition) =>
        p.bar < this.staff.bars.length && p.beat < this.beatCount(p.bar);
      if (!inside(this._selection.anchor) || !inside(this._selection.head)) this._selection = null;
    }
  }

  private moved(message = this.describeCursor()) {
    this.pendingDigit = null;
    this.pendingDrum = null;
    this._message = message;
    this.emit("cursor");
  }

  /** Shows another track (the editor always works on the shown track). */
  setTrack(index: number) {
    if (index === this._cursor.track || !this.score.tracks[index]) return;
    this._cursor = { ...this._cursor, track: index, voice: 0, pitch: null };
    this._cursor.string = this.defaultString();
    this._selection = null;
    this.clamp();
    this.moved();
  }

  /** Puts the cursor on a beat (e.g. a click in the score). Shift extends the selection. */
  setCursorTo(
    target: { bar: number; beat: number; voice?: number; note?: Note | null },
    extend = false,
  ) {
    const from: BeatPosition = { bar: this._cursor.bar, beat: this._cursor.beat };
    this._cursor.bar = target.bar;
    this._cursor.beat = target.beat;
    if (target.voice !== undefined) this._cursor.voice = target.voice;
    const note = target.note;
    if (note?.isStringed) this._cursor.string = note.string;
    else if (note) this._cursor.pitch = pitchOf(note);
    this.clamp();
    this.updateSelection(extend, from);
    this.moved();
  }

  private updateSelection(extend: boolean, from: BeatPosition) {
    const head = { bar: this._cursor.bar, beat: this._cursor.beat };
    if (!extend) {
      this._selection = null;
      return;
    }
    const anchor = this._selection?.anchor ?? from;
    this._selection = comparePositions(anchor, head) === 0 ? null : { anchor, head };
  }

  /**
   * Moves to the next or previous beat. Past the last beat, it adds a beat
   * (when the bar still has room) or a new bar at the end of the song, so
   * music can be typed without reaching for the mouse.
   */
  moveBeat(step: 1 | -1, extend = false) {
    const from: BeatPosition = { bar: this._cursor.bar, beat: this._cursor.beat };
    const c = this._cursor;
    if (step < 0) {
      if (c.beat > 0) c.beat--;
      else if (c.bar > 0) {
        c.bar--;
        c.beat = this.beatCount(c.bar) - 1;
      }
    } else if (c.beat < this.beatCount(c.bar) - 1) {
      c.beat++;
    } else if (!extend && this.canGrowBar()) {
      this.addBeatAfterCursor();
      return;
    } else if (c.bar < this.staff.bars.length - 1) {
      c.bar++;
      c.beat = 0;
    } else if (!extend && this.hasWrittenMusic(this.beatAt())) {
      this.addBarAtEnd();
      return;
    }
    this.updateSelection(extend, from);
    this.moved();
  }

  moveBar(step: 1 | -1, extend = false) {
    const from: BeatPosition = { bar: this._cursor.bar, beat: this._cursor.beat };
    const c = this._cursor;
    const target = c.bar + step;
    if (target >= 0 && target < this.staff.bars.length) {
      c.bar = target;
      c.beat = extend && step > 0 ? this.beatCount(target) - 1 : 0;
    } else if (step < 0) {
      c.beat = 0;
    }
    this.updateSelection(extend, from);
    this.moved();
  }

  /** Up and down: the string (tab), or the next higher or lower note of the chord. */
  moveString(step: 1 | -1) {
    if (this.kind === "stringed") {
      // Up the screen is a higher string, which alphaTab numbers higher.
      this._cursor.string = Math.min(this.stringCount, Math.max(1, this._cursor.string + step));
    } else if (this.kind === "drums") {
      this.moveDrumLine(step);
      return;
    } else {
      const pitches = this.beatInfo.notes.map((n) => n.pitch).sort((a, b) => a - b);
      if (pitches.length > 0) {
        const index = this._cursor.pitch === null ? -1 : pitches.indexOf(this._cursor.pitch);
        const next = index < 0 ? (step > 0 ? 0 : pitches.length - 1) : index + step;
        this._cursor.pitch = pitches[Math.min(pitches.length - 1, Math.max(0, next))]!;
      }
    }
    this.moved();
  }

  /**
   * The drums of the cursor's beat, top line of the drum tab first (cymbals …
   * kick), on the lines they were placed on (#53).
   */
  private drumsTopDown(): number[] {
    const beat = this.beatAt();
    if (!beat) return [];
    const lines = placeDrums(beat.notes);
    const line = (note: Note) => lines.get(note) ?? drumTabString(pitchOf(note));
    return [
      ...new Set(
        [...beat.notes].sort((a, b) => line(b) - line(a) || pitchOf(b) - pitchOf(a)).map(pitchOf),
      ),
    ];
  }

  /** Alt+Up/Down on a drum: moves it to the line above or below in the drum tab (#53). */
  private moveDrumToLine(step: 1 | -1) {
    const beat = this.beatAt();
    const note = this.noteAtCursor();
    if (!beat || !note) return;
    const now = placeDrums(beat.notes).get(note) ?? drumLine(note) ?? 1;
    const line = now + step;
    if (line < 1 || line > DRUM_TAB_LINES) {
      this.announce(step > 0 ? "Already on the top line" : "Already on the bottom line");
      return;
    }
    this.run(
      "Move drum to another line",
      this.cursorTargets,
      () => {
        const target = this.noteAtCursor();
        if (target) setDrumLine(target, line);
      },
      `${drumNumberName(pitchOf(note))} on line ${DRUM_TAB_LINES + 1 - line} of the drum tab`,
    );
  }

  /**
   * Drums: Up and Down walk the beat's drums line by line (as in the drum
   * tab); past the top or bottom drum they go to the other voice.
   */
  private moveDrumLine(step: 1 | -1) {
    const drums = this.drumsTopDown();
    const index = this._cursor.pitch === null ? -1 : drums.indexOf(this._cursor.pitch);
    // Up the screen is towards the top line, the start of the list.
    const next = index < 0 ? (step > 0 ? 0 : drums.length - 1) : index - step;
    if (drums.length > 0 && next >= 0 && next < drums.length) {
      this._cursor.pitch = drums[next]!;
      this.moved();
      return;
    }
    const other = this._cursor.voice === 0 ? 1 : 0;
    const otherVoice = this.staff.bars[this._cursor.bar]?.voices[other];
    if (!otherVoice || otherVoice.isEmpty) {
      this.moved();
      return;
    }
    this.switchVoice(other);
    const there = this.drumsTopDown();
    this._cursor.pitch = (step > 0 ? there.at(-1) : there[0]) ?? null;
    this.moved();
  }

  /** R: the next drum number typed replaces the drum under the cursor. */
  startDrumReplace() {
    if (this.kind !== "drums") return;
    const note = this.noteAtCursor();
    if (!note) {
      this.announce("No drum at the cursor to replace");
      return;
    }
    this.replacingDrum = true;
    this.announce(`Replace ${drumNumberName(pitchOf(note))}: type the new drum number`);
  }

  /** Puts another drum in place of the one under the cursor. */
  replaceDrum(sound: number) {
    this.replacingDrum = false;
    const note = this.noteAtCursor();
    if (this.kind !== "drums" || !note) {
      this.enterDrum(sound);
      return;
    }
    const old = pitchOf(note);
    if (old === sound) return;
    if (this.beatAt()?.notes.some((n) => pitchOf(n) === sound)) {
      this.announce(`${drumNumberName(sound)} is already on this beat`);
      return;
    }
    const own = this.track.percussionArticulations.findIndex((a) => a.outputMidiNumber === sound);
    this.run(
      "Replace note",
      this.cursorTargets,
      () => {
        const target = this.noteAtCursor()!;
        target.percussionArticulation = own >= 0 ? own : sound;
        this._cursor.pitch = sound;
      },
      `${drumNumberName(old)} replaced by ${drumNumberName(sound)}`,
    );
  }

  /** Puts the cursor on a string (1 = lowest), e.g. from a fretboard click. */
  setString(string: number) {
    if (this.kind !== "stringed") return;
    this._cursor.string = Math.min(this.stringCount, Math.max(1, string));
    this.moved();
  }

  /**
   * Keeps the cursor on a track that moved (call inside {@link run}, so undo
   * and redo put it back too).
   */
  placeCursorOnTrack(index: number) {
    if (!this.score.tracks[index]) return;
    if (index !== this._cursor.track) {
      this._cursor = { ...this._cursor, track: index, voice: 0, pitch: null };
      this._cursor.string = this.defaultString();
      this._selection = null;
    }
  }

  switchVoice(voice: number) {
    if (voice === this._cursor.voice || voice < 0 || voice >= MAX_VOICES) return;
    this._cursor.voice = voice;
    this._selection = null;
    this.clamp();
    this.moved(`Voice ${voice + 1}. ${this.describeCursor()}`);
  }

  selectAll() {
    const lastBar = this.staff.bars.length - 1;
    this._selection = {
      anchor: { bar: 0, beat: 0 },
      head: { bar: lastBar, beat: this.beatCount(lastBar) - 1 },
    };
    this._cursor.bar = lastBar;
    this._cursor.beat = this.beatCount(lastBar) - 1;
    this.moved(`Selected the whole track, ${this.staff.bars.length} bars`);
  }

  clearSelection() {
    if (!this._selection) return;
    this._selection = null;
    this.moved("Selection cleared");
  }

  /** Beats covered by the selection (or the cursor's beat), grouped by bar. */
  private selectedPositions(): BeatPosition[][] {
    const [start, end] = this._selection
      ? selectionRange(this._selection)
      : [this._cursor, this._cursor];
    const bars: BeatPosition[][] = [];
    for (let bar = start.bar; bar <= end.bar; bar++) {
      const first = bar === start.bar ? start.beat : 0;
      const last = bar === end.bar ? end.beat : this.beatCount(bar) - 1;
      const positions: BeatPosition[] = [];
      for (let beat = first; beat <= last; beat++) positions.push({ bar, beat });
      bars.push(positions);
    }
    return bars;
  }

  private selectedBeats(): Beat[] {
    return this.selectedPositions()
      .flat()
      .map((p) => this.beatAt(p))
      .filter((beat): beat is Beat => beat !== null && !beat.isEmpty);
  }

  private hasWrittenMusic(beat: Beat | null): boolean {
    return beat !== null && !beat.isEmpty && beat.notes.length > 0;
  }

  /** The bar at the cursor has written music and is not full yet. */
  private canGrowBar(): boolean {
    const voice = this.voice();
    const beat = this.beatAt();
    if (!voice || !beat || !this.hasWrittenMusic(beat)) return false;
    const masterBar = this.bar().masterBar;
    return voice.calculateDuration() < masterBar.calculateDuration();
  }

  describeCursor(): string {
    const c = this._cursor;
    const parts = [`Bar ${c.bar + 1}`, `beat ${c.beat + 1} of ${this.beatCount(c.bar)}`];
    const info = this.beatInfo;
    if (this.kind === "stringed") {
      const open = tuningOf(this.staff)[this.stringCount - c.string];
      const userString = this.stringCount - c.string + 1;
      parts.push(
        `string ${userString}${open === undefined ? "" : ` (${pitchName(open, { octave: false, spoken: true })})`}`,
      );
      const note = info.notes.find((n) => n.string === c.string);
      if (note) parts.push(`fret ${note.fret}${note.tied ? ", tied" : ""}`);
    } else if (c.pitch !== null && info.notes.some((n) => n.pitch === c.pitch)) {
      parts.push(
        this.kind === "drums" ? drumNumberName(c.pitch) : pitchName(c.pitch, { spoken: true }),
      );
    }
    parts.push(...this.effectNames());
    const beat = this.beatAt();
    if (!beat || isPlaceholder(beat))
      parts.push(`empty, next note ${noteValueLabel(info.duration)}`);
    else
      parts.push(
        info.rest ? `${noteValueLabel(info.duration)} rest` : noteValueLabel(info.duration),
      );
    return parts.join(", ");
  }

  // --- Editing ---------------------------------------------------------------

  /**
   * Runs an edit as one undo step: records `targets` before and after,
   * re-finishes the model and notifies listeners.
   */
  run(label: string, targets: () => Iterable<object>, apply: () => void, message = label) {
    track(EDIT_EVENTS[label] ?? "edit");
    // Any edit ends a two-digit fret: its second digit must not undo this edit.
    this.pendingDigit = null;
    this.pendingDrum = null;
    const before: HistoryExtra = {
      cursor: { ...this._cursor },
      selection: this._selection ? { ...this._selection } : null,
    };
    this.history.record(label, targets, apply, {
      before,
      after: () => ({
        cursor: { ...this._cursor },
        selection: this._selection ? { ...this._selection } : null,
      }),
    });
    this.changed(message);
  }

  private changed(message: string) {
    refinish(this.score);
    this._revision++;
    this.clamp();
    this._message = message;
    this.emit("model");
  }

  undo() {
    const entry = this.history.undo();
    if (!entry) return;
    track("undo");
    this.pendingDigit = null;
    this.pendingDrum = null;
    this._cursor = { ...entry.extra.before.cursor };
    this._selection = entry.extra.before.selection;
    this.changed(`Undo ${entry.label}`);
  }

  redo() {
    const entry = this.history.redo();
    if (!entry) return;
    track("redo");
    this.pendingDigit = null;
    this.pendingDrum = null;
    this._cursor = { ...entry.extra.after.cursor };
    this._selection = entry.extra.after.selection;
    this.changed(`Redo ${entry.label}`);
  }

  /** Snapshot targets: the cursor's bar, or the whole staff when voices must be added. */
  private cursorTargets = () =>
    this._cursor.voice < this.bar().voices.length
      ? barContent(this.bar())
      : staffContent(this.staff);

  private selectionTargets = () => {
    const bars = this.selectedPositions().map((positions) => positions[0]!.bar);
    return bars.flatMap((bar) => [...barContent(this.bar(bar))]);
  };

  /** The beat under the cursor, creating voice 2 if needed (call inside an edit). */
  private writableBeat(): Beat {
    ensureVoices(this.staff, this._cursor.voice + 1);
    return this.beatAt()!;
  }

  /**
   * Prepares a rest or empty beat for its first note. In an empty bar the
   * note gets the current note value instead of the whole-bar rest's.
   */
  private prepareForNote(beat: Beat) {
    if (isPlaceholder(beat)) {
      beat.duration = this._entryDuration;
      beat.dots = 0;
      beat.tupletNumerator = 1;
      beat.tupletDenominator = 1;
    }
    beat.isEmpty = false;
  }

  /** Types a digit on a tab track: a fret, or the second digit of one ("1", "2" = 12). */
  typeDigit(digit: number, now = Date.now()) {
    if (this.kind === "drums") {
      this.typeDrumDigit(digit, now);
      return;
    }
    if (this.kind !== "stringed") return;
    const c = this._cursor;
    const key = `${c.track}:${c.voice}:${c.bar}:${c.beat}:${c.string}`;
    const pending = this.pendingDigit;
    const fret =
      pending && pending.key === key && now - pending.at < TWO_DIGIT_MS
        ? pending.digit * 10 + digit
        : null;
    if (fret !== null && fret <= MAX_FRET) {
      // Replace the first digit's edit with the combined fret: one undo step.
      this.history.undo();
      this.pendingDigit = null;
      this.pendingDrum = null;
      this.setFret(fret);
      return;
    }
    this.setFret(digit);
    this.pendingDigit = { digit, at: now, key };
  }

  /**
   * Types a drum number on a drum track, e.g. "4" then "6" for 46, the open
   * hi-hat (the General MIDI numbers of Guitar Pro's drum kit). Digits typed
   * within a moment of each other form one number; as soon as it is a known
   * drum it is entered. A number already on the beat is removed again; another
   * one is added to the beat, so two drums can sound together.
   */
  private typeDrumDigit(digit: number, now: number) {
    const c = this._cursor;
    const key = `${c.track}:${c.voice}:${c.bar}:${c.beat}`;
    const pending = this.pendingDrum;
    const continued = pending && pending.key === key && now - pending.at < DRUM_DIGITS_MS;
    const text = continued && pending.text.length < 3 ? pending.text + digit : String(digit);
    const sound = Number(text);
    if (DRUM_MIDI_MAP[sound] !== undefined) {
      this.pendingDrum = null;
      if (this.replacingDrum) this.replaceDrum(sound);
      else this.toggleDrum(sound);
      return;
    }
    if (text.length >= 3) {
      this.pendingDrum = null;
      this.announce(`No drum sound ${sound}`);
      return;
    }
    this.announce(`Drum number ${text}…`); // (clears the pending number: set it after)
    this.pendingDrum = { text, at: now, key };
  }

  /** Adds a drum sound to the cursor's beat, or removes it when it is already there. */
  toggleDrum(sound: number) {
    const existing = this.beatAt()?.notes.find((note) => pitchOf(note) === sound);
    if (!existing) {
      this.enterDrum(sound);
      return;
    }
    this.run(
      "Remove note",
      this.cursorTargets,
      () => {
        const beat = this.writableBeat();
        const note = beat.notes.find((n) => pitchOf(n) === sound);
        if (note) beat.removeNote(note);
        this._cursor.pitch = null;
      },
      `${drumNumberName(sound)} removed`,
    );
  }

  /**
   * Fills the bar at the cursor (or every selected bar) with rests of the
   * selected note value, e.g. 1/32: the skeleton of a groove, to fill in by
   * typing drum numbers. Works on the cursor's voice.
   */
  fillWithRests() {
    const duration = this.beatInfo.duration;
    const [start, end] = this._selection
      ? selectionRange(this._selection)
      : [this._cursor, this._cursor];
    const voiceIndex = this._cursor.voice;
    const from = start.bar;
    const to = end.bar;
    const bars = to - from + 1;
    this.editBars(
      "Fill with rests",
      { from, to },
      () => {
        for (let index = from; index <= to; index++) {
          const voice = this.staff.bars[index]?.voices[voiceIndex];
          if (!voice) continue;
          const barTicks = this.score.masterBars[index]!.calculateDuration();
          voice.beats = [];
          for (const rest of restsFor(barTicks, duration)) {
            voice.addBeat(newBeat(rest.duration, rest.dots));
          }
        }
        this._cursor.bar = from;
        this._cursor.beat = 0;
        this._cursor.pitch = null;
        this._selection = null;
      },
      `${bars === 1 ? "Bar" : `${bars} bars`} filled with ${noteValueLabel(duration)} rests`,
    );
  }

  /** Writes a fret on the cursor's string (tab tracks). */
  setFret(fret: number) {
    if (this.kind !== "stringed" || fret < 0 || fret > MAX_FRET) return;
    const existing = this.noteAtCursor();
    this.noteEntered?.(this.openPitch(this._cursor.string) + fret);
    // The same fret again (the first click of a double-click delete) changes nothing.
    if (existing && existing.fret === fret && !existing.isTieDestination) return;
    this.run(
      existing ? "Change note" : "Add note",
      this.cursorTargets,
      () => {
        const beat = this.writableBeat();
        this.prepareForNote(beat);
        const note = beat.getNoteOnString(this._cursor.string);
        if (note) {
          setNoteFret(note, fret);
          note.isTieDestination = false;
        } else {
          const added = new model.Note();
          added.string = this._cursor.string;
          added.fret = fret;
          beat.addNote(added);
        }
      },
      `Fret ${fret} on string ${this.stringCount - this._cursor.string + 1}`,
    );
  }

  /** The pitch a letter (A–G) means here: near the note at the cursor or the one before. */
  private nearbyPitch(): number {
    const beat = this.beatAt();
    // The fretted pitch: a harmonic sounds higher than the note it is played on.
    const fretted = (note: Note) => note.calculateRealValue(true, false);
    const current = this.noteAtCursor(beat);
    if (current) return fretted(current);
    for (let b: Beat | null = beat?.previousBeat ?? null; b; b = b.previousBeat) {
      if (b.notes.length > 0 && !b.notes[0]!.isPercussion) return fretted(b.notes[0]!);
    }
    if (this.kind === "stringed") {
      const tuning = tuningOf(this.staff);
      return tuning[this.stringCount - this._cursor.string]! + this.staff.capo + 5;
    }
    return 60; // middle C
  }

  /**
   * Enters a pitch from its letter name, in the octave nearest the music
   * around it, with the bar's key signature applied (F is F sharp in G major).
   */
  enterLetter(letter: string) {
    const natural = pitchFromLetter(letter, this.nearbyPitch());
    if (natural === null) return;
    this.enterPitch(natural + keyAlteration(letter, this.bar().keySignature));
  }

  /**
   * Adds a note by pitch (staff entry, piano keyboard, letters). On a tab
   * track it goes on the cursor's string if playable there, otherwise on the
   * nearest string where it is.
   */
  enterPitch(pitch: number) {
    if (this.kind === "drums") return;
    if (this.kind === "stringed") {
      const string = this.stringFor(pitch);
      if (string === null) {
        this._message = `${pitchName(pitch, { spoken: true })} can't be played on this instrument`;
        this.emit("cursor");
        return;
      }
      this._cursor.string = string;
      this.setFret(pitch - this.openPitch(string));
      return;
    }
    const beat = this.beatAt();
    this.noteEntered?.(pitch);
    if (beat?.notes.some((note) => note.realValue === pitch)) {
      this._cursor.pitch = pitch;
      this.moved();
      return;
    }
    this.run(
      "Add note",
      this.cursorTargets,
      () => {
        const target = this.writableBeat();
        this.prepareForNote(target);
        const note = new model.Note();
        note.octave = Math.floor(pitch / 12);
        note.tone = pitch % 12;
        target.addNote(note);
        this._cursor.pitch = pitch;
      },
      pitchName(pitch, { spoken: true }),
    );
  }

  /** Sounding pitch of an open string, capo included. */
  private openPitch(string: number): number {
    return tuningOf(this.staff)[this.stringCount - string]! + this.staff.capo;
  }

  /** The string to play `pitch` on: the cursor's if possible, else the nearest. */
  private stringFor(pitch: number): number | null {
    const candidates: number[] = [];
    for (let string = 1; string <= this.stringCount; string++) {
      const fret = pitch - this.openPitch(string);
      if (fret >= 0 && fret <= MAX_FRET) candidates.push(string);
    }
    if (candidates.length === 0) return null;
    const beat = this.beatAt();
    const cursor = this._cursor.string;
    const free = (string: number) => string === cursor || !beat?.hasNoteOnString(string);
    const ranked = [...candidates].sort(
      (a, b) =>
        Number(free(b)) - Number(free(a)) ||
        Math.abs(a - cursor) - Math.abs(b - cursor) ||
        pitch - this.openPitch(a) - (pitch - this.openPitch(b)),
    );
    return ranked[0]!;
  }

  /** Adds a drum sound (its General MIDI key, e.g. 38 for the snare). */
  enterDrum(sound: number) {
    if (this.kind !== "drums") return;
    const beat = this.beatAt();
    if (beat?.notes.some((note) => pitchOf(note) === sound)) {
      this._cursor.pitch = sound;
      this.moved();
      return;
    }
    // Tracks with their own articulations (Guitar Pro 6+) refer to them by index.
    const own = this.track.percussionArticulations.findIndex((a) => a.outputMidiNumber === sound);
    this.run(
      "Add note",
      this.cursorTargets,
      () => {
        const target = this.writableBeat();
        this.prepareForNote(target);
        const note = new model.Note();
        note.percussionArticulation = own >= 0 ? own : sound;
        target.addNote(note);
        this._cursor.pitch = sound;
      },
      drumNumberName(sound),
    );
  }

  /** Moves the note under the cursor up or down a semitone. */
  transpose(step: 1 | -1) {
    if (this.kind === "drums") {
      this.moveDrumToLine(step);
      return;
    }
    const note = this.noteAtCursor();
    if (!note) return;
    if (this.kind === "stringed") {
      const fret = note.fret + step;
      if (fret < 0 || fret > MAX_FRET) return;
      this.run(
        "Change note",
        this.cursorTargets,
        () => {
          const target = this.noteAtCursor()!;
          setNoteFret(target, fret);
          target.isTieDestination = false;
        },
        `Fret ${fret}`,
      );
      return;
    }
    const pitch = note.realValue + step;
    this.run(
      "Change note",
      this.cursorTargets,
      () => {
        const target = this.noteAtCursor()!;
        target.octave = Math.floor(pitch / 12);
        target.tone = pitch % 12;
        this._cursor.pitch = pitch;
      },
      pitchName(pitch, { spoken: true }),
    );
  }

  /**
   * Delete: with a selection, turns it into rests. Otherwise removes the note
   * under the cursor, or the beat itself when it holds no notes.
   */
  deleteAtCursor() {
    if (this._selection) {
      this.clearNotes("Clear");
      return;
    }
    const beat = this.beatAt();
    if (!beat) return;
    const note =
      this.noteAtCursor(beat) ?? (this.kind === "stringed" ? null : (beat.notes.at(-1) ?? null));
    if (note) {
      this.run("Delete note", this.cursorTargets, () => {
        const target = this.noteAtCursor() ?? this.beatAt()!.notes.at(-1)!;
        target.beat.removeNote(target);
        this._cursor.pitch = null;
      });
      return;
    }
    if (!beat.isEmpty && beat.voice.beats.length > 1) this.deleteBeats();
  }

  /**
   * Removes only the note under the cursor (a double-click on the fretboard): no selection
   * handling, and an empty beat stays. Returns whether a note was removed.
   */
  removeCursorNote(): boolean {
    if (!this.noteAtCursor()) return false;
    this.run("Delete note", this.cursorTargets, () => {
      const target = this.noteAtCursor();
      if (target) target.beat.removeNote(target);
      this._cursor.pitch = null;
    });
    return true;
  }

  /** Turns the selected beats (or the cursor's) into rests of the same length. */
  clearNotes(label = "Make rest") {
    const beats = this.selectedBeats();
    if (beats.length === 0 || beats.every((b) => b.notes.length === 0)) return;
    this.run(label, this.selectionTargets, () => {
      for (const beat of this.selectedBeats()) {
        for (const note of [...beat.notes]) beat.removeNote(note);
      }
      this._cursor.pitch = null;
    });
  }

  /** Removes the selected beats (or the cursor's). A bar left empty gets its rest back. */
  deleteBeats() {
    const positions = this.selectedPositions();
    const count = positions.flat().length;
    this.run(count > 1 ? "Delete beats" : "Delete beat", this.selectionTargets, () => {
      for (const barPositions of positions) {
        const bar = this.bar(barPositions[0]!.bar);
        const voice = bar.voices[this._cursor.voice];
        if (!voice) continue;
        const first = barPositions[0]!.beat;
        voice.beats.splice(first, barPositions.length);
        if (voice.beats.length === 0) {
          for (const beat of placeholderBeats(bar.masterBar, voice.index)) voice.addBeat(beat);
        }
      }
      const [start] = this._selection ? selectionRange(this._selection) : [this._cursor];
      this._cursor.bar = start.bar;
      this._cursor.beat = start.beat;
      this._selection = null;
    });
  }

  /** Inserts a rest before the cursor, as long as the beat at the cursor. */
  insertBeat() {
    this.run("Insert beat", this.cursorTargets, () => {
      const current = this.writableBeat();
      const beat = current.isEmpty
        ? newBeat(this._entryDuration)
        : newBeat(current.duration, current.dots, {
            numerator: current.tupletNumerator,
            denominator: current.tupletDenominator,
          });
      current.voice.beats.splice(current.index, 0, beat);
    });
  }

  /** Appends a rest after the cursor's beat (moving right at the end of a bar). */
  private addBeatAfterCursor() {
    this.run("Add beat", this.cursorTargets, () => {
      const current = this.writableBeat();
      const beat = newBeat(current.duration, current.dots, {
        numerator: current.tupletNumerator,
        denominator: current.tupletDenominator,
      });
      current.voice.beats.splice(current.index + 1, 0, beat);
      this._cursor.beat++;
      this._selection = null;
    });
  }

  private addBarAtEnd() {
    this.run(
      "Add bar",
      () => this.structureTargets(),
      () => {
        appendMasterBar(this.score);
        this._cursor.bar = this.staff.bars.length - 1;
        this._cursor.beat = 0;
        this._selection = null;
      },
    );
  }

  /** Objects whose lists change when bars or tracks are added or removed. */
  structureTargets(): object[] {
    return [this.score, ...this.score.tracks.flatMap((track) => [track, ...track.staves])];
  }

  private forSelectedBeats(label: string, change: (beat: Beat) => void, message?: string) {
    if (this.selectedBeats().length === 0 && !this.beatAt()?.isEmpty) return;
    this.run(
      label,
      this._selection ? this.selectionTargets : this.cursorTargets,
      () => {
        const beats = this._selection ? this.selectedBeats() : [this.writableBeat()];
        for (const beat of beats) change(beat);
      },
      message,
    );
  }

  setDuration(duration: Duration) {
    this._entryDuration = duration;
    const beat = this.beatAt();
    if (!this._selection && (!beat || isPlaceholder(beat))) {
      // Nothing written here yet: the value is used for the next note typed.
      this._message = noteValueLabel(duration);
      this.emit("cursor");
      return;
    }
    this.forSelectedBeats(
      "Change duration",
      (b) => {
        b.duration = duration;
      },
      noteValueLabel(duration),
    );
  }

  /** Shorter (`1`) or longer (`-1`) note value, like Guitar Pro's + and − keys. */
  stepDuration(step: 1 | -1) {
    this.setDuration(stepDuration(this.beatInfo.duration, step));
  }

  /** Toggles a single (`1`) or double (`2`) dot. */
  toggleDots(dots: 1 | 2) {
    const next = this.beatInfo.dots === dots ? 0 : dots;
    this.forSelectedBeats(
      "Change dots",
      (beat) => {
        beat.dots = next;
      },
      next === 0 ? "No dot" : next === 1 ? "Dotted" : "Double dotted",
    );
  }

  setTuplet(tuplet: Tuplet) {
    this.forSelectedBeats(
      "Change tuplet",
      (beat) => {
        beat.tupletNumerator = tuplet.numerator;
        beat.tupletDenominator = tuplet.denominator;
      },
      tuplet.numerator === 1 ? "No tuplet" : `Tuplet ${tuplet.numerator} in ${tuplet.denominator}`,
    );
  }

  /**
   * Ties the note under the cursor to the same note before it (or unties it).
   * On an empty string, adds a note tied to the previous beat's note there.
   */
  toggleTie() {
    const beat = this.beatAt();
    if (!beat || this.kind === "drums") return;
    const note = this.noteAtCursor(beat);
    const previous = beat.previousBeat;
    if (note) {
      const tied = !note.isTieDestination;
      this.run(tied ? "Tie note" : "Untie note", this.cursorTargets, () => {
        this.noteAtCursor()!.isTieDestination = tied;
      });
      return;
    }
    const origins =
      this.kind === "stringed"
        ? [previous?.getNoteOnString(this._cursor.string)].filter((n): n is Note => !!n)
        : (previous?.notes ?? []);
    if (origins.length === 0) return;
    this.run("Tie note", this.cursorTargets, () => {
      const target = this.writableBeat();
      this.prepareForNote(target);
      for (const origin of origins) {
        const tied = cloneNote(origin);
        tied.isTieDestination = true;
        target.addNote(tied);
      }
    });
  }

  // --- Effects, text and chords ---------------------------------------------

  /** Names of the effects on the cursor's note and beat ("palm mute", "grace note"). */
  private effectNames(): string[] {
    const beat = this.beatAt();
    if (!beat || isPlaceholder(beat)) return [];
    const note = this.noteAtCursor(beat);
    const names: string[] = [];
    if (note) {
      for (const effect of Object.values(NOTE_EFFECTS) as Effect[]) {
        // Accidentals are part of the pitch the status already names.
        if (effect.id === "trillSpeed" || effect.id === "accidental") continue;
        const value = (effect as (typeof NOTE_EFFECTS)[NoteEffectId]).get(note);
        if (value !== effectOff(effect)) names.push(activeEffectName(effect, value));
      }
      if (note.hasBend) names.push("bend");
    }
    for (const effect of Object.values(BEAT_EFFECTS) as Effect[]) {
      const value = (effect as (typeof BEAT_EFFECTS)[BeatEffectId]).get(beat);
      if (value !== effectOff(effect)) names.push(activeEffectName(effect, value));
    }
    if (beat.hasWhammyBar) names.push("whammy bar");
    if (beat.graceType !== GraceType.None) names.push("grace note");
    return names;
  }

  /** The effects at the cursor, as plain data. */
  get effects(): EffectsInfo {
    const beat = this.beatAt();
    const written = beat && !isPlaceholder(beat) ? beat : null;
    const note = written ? this.noteAtCursor(written) : null;
    const read = <T>(effects: Record<string, { get(target: T): number }>, target: T) =>
      Object.fromEntries(Object.entries(effects).map(([id, e]) => [id, e.get(target)]));
    return {
      note: note ? (read(NOTE_EFFECTS, note) as Record<NoteEffectId, number>) : null,
      beat:
        written && written.notes.length > 0
          ? (read(BEAT_EFFECTS, written) as Record<BeatEffectId, number>)
          : null,
      bend: note ? bendOf(note) : null,
      whammy: written ? whammyOf(written) : null,
      grace: written?.graceType ?? GraceType.None,
      text: beat?.text ?? null,
      chord: beat ? chordOf(beat) : null,
    };
  }

  /** The notes effects apply to: every note of the selected beats, or the cursor's note. */
  private effectNotes(): Note[] {
    if (this._selection) return this.selectedBeats().flatMap((beat) => beat.notes);
    const note = this.noteAtCursor();
    return note ? [note] : [];
  }

  /** The beats beat effects apply to: the selected beats with notes, or the cursor's. */
  private effectBeats(): Beat[] {
    const beats = this._selection ? this.selectedBeats() : [this.beatAt()];
    return beats.filter((beat): beat is Beat => !!beat && !beat.isEmpty && beat.notes.length > 0);
  }

  /** Says why nothing happened (no undo step), e.g. "No note at the cursor". */
  private refuse(message: string) {
    this.announce(message);
  }

  /** Announces a message (to screen readers, in the status) without changing anything. */
  announce(message: string) {
    this.pendingDigit = null;
    this.pendingDrum = null;
    this._message = message;
    this.emit("cursor");
  }

  private get effectTargets() {
    return this._selection ? this.selectionTargets : this.cursorTargets;
  }

  /** Why an effect can't be used here, or null when it can. */
  private effectProblem(effect: Effect, targets: readonly unknown[]): string | null {
    if (!effectAvailable(effect, this.kind)) return unavailableText(effect);
    if (targets.length === 0) {
      return effect.scope === "note" ? "No note at the cursor" : "No notes on this beat";
    }
    return null;
  }

  /** Sets a note effect on the cursor's note (or every selected note). */
  setNoteEffect(id: NoteEffectId, value: number) {
    const effect: Effect = NOTE_EFFECTS[id];
    const notes = this.effectNotes();
    const problem = this.effectProblem(effect, notes);
    if (problem) return this.refuse(problem);
    const off = value === effectOff(effect);
    if (
      !off &&
      id === "hammerPull" &&
      !notes.some((n) => model.Note.findHammerPullDestination(n))
    ) {
      return this.refuse("A hammer-on or pull-off needs a next note on the same string");
    }
    if (
      !off &&
      id === "slideOut" &&
      (value === model.SlideOutType.Shift || value === model.SlideOutType.Legato) &&
      !notes.some((n) => model.Note.nextNoteOnSameLine(n))
    ) {
      return this.refuse("A slide to the next note needs a next note on the same string");
    }
    const had = notes.some((n) => NOTE_EFFECTS[id].get(n) !== effectOff(effect));
    const label = off
      ? `Remove ${effect.label.toLowerCase()}`
      : had
        ? `Change ${effect.label.toLowerCase()}`
        : `Add ${effect.label.toLowerCase()}`;
    this.run(
      label,
      this.effectTargets,
      () => {
        for (const note of this.effectNotes()) NOTE_EFFECTS[id].set(note, value);
      },
      effectText(effect, value),
    );
  }

  /** Switches a note effect on (its usual value) or, when every target has it, off. */
  toggleNoteEffect(id: NoteEffectId) {
    const effect: Effect = NOTE_EFFECTS[id];
    const notes = this.effectNotes();
    const on =
      notes.length > 0 && notes.every((n) => NOTE_EFFECTS[id].get(n) !== effectOff(effect));
    this.setNoteEffect(id, on ? effectOff(effect) : effect.on);
  }

  /** Sets a beat effect on the cursor's beat (or every selected beat). */
  setBeatEffect(id: BeatEffectId, value: number) {
    const effect: Effect = BEAT_EFFECTS[id];
    const beats = this.effectBeats();
    const problem = this.effectProblem(effect, beats);
    if (problem) return this.refuse(problem);
    const off = value === effectOff(effect);
    const had = beats.some((b) => BEAT_EFFECTS[id].get(b) !== effectOff(effect));
    const label = off
      ? `Remove ${effect.label.toLowerCase()}`
      : had
        ? `Change ${effect.label.toLowerCase()}`
        : `Add ${effect.label.toLowerCase()}`;
    this.run(
      label,
      this.effectTargets,
      () => {
        for (const beat of this.effectBeats()) BEAT_EFFECTS[id].set(beat, value);
      },
      effectText(effect, value),
    );
  }

  toggleBeatEffect(id: BeatEffectId) {
    const effect: Effect = BEAT_EFFECTS[id];
    const beats = this.effectBeats();
    const on =
      beats.length > 0 && beats.every((b) => BEAT_EFFECTS[id].get(b) !== effectOff(effect));
    this.setBeatEffect(id, on ? effectOff(effect) : effect.on);
  }

  // --- Palette state (#53) ----------------------------------------------------

  /**
   * Whether an effect is set on the selection (or the cursor's note or beat):
   * on every target, on some of them ("mixed"), or on none. With `value`,
   * whether it has that value; without, whether it is anything but off.
   */
  effectState(scope: "note" | "beat", id: string, value?: number): ToggleState {
    const effect = (scope === "note" ? NOTE_EFFECTS : BEAT_EFFECTS)[
      id as keyof typeof NOTE_EFFECTS & keyof typeof BEAT_EFFECTS
    ] as Effect | undefined;
    if (!effect) return "off";
    const read = (target: Note | Beat) =>
      (effect as unknown as { get(t: Note | Beat): number }).get(target);
    const targets: (Note | Beat)[] = scope === "note" ? this.effectNotes() : this.effectBeats();
    const on = (target: Note | Beat) =>
      value === undefined ? read(target) !== effectOff(effect) : read(target) === value;
    return stateOf(targets.map(on));
  }

  /** Whether `test` holds for the selected beats (or the cursor's beat): all, some or none. */
  beatsState(test: (beat: Beat) => boolean): ToggleState {
    const beats = this._selection ? this.selectedBeats() : [this.beatAt()];
    return stateOf(beats.filter((b): b is Beat => !!b && !isPlaceholder(b)).map(test));
  }

  /** The value an exclusive group shows (one pressed button): the cursor's note or beat. */
  effectValue(scope: "note" | "beat", id: string): number | null {
    const info = this.effects;
    const values = (scope === "note" ? info.note : info.beat) as Record<string, number> | null;
    return values?.[id] ?? null;
  }

  /** Fermata on the selected beats (or the cursor's beat). */
  get fermataState(): ToggleState {
    return stateOf(this.effectBeats().map((beat) => beat.fermata !== null));
  }

  /** Puts a fermata on the selected beats (or the cursor's beat), or takes it off them all. */
  toggleFermata() {
    const beats = this.effectBeats();
    if (beats.length === 0) return this.refuse("No notes on this beat");
    const off = beats.every((beat) => beat.fermata !== null);
    const bars = beats.map((beat) => beat.voice.bar.index);
    this.run(
      off ? "Remove fermata" : "Add fermata",
      () => masterBarContent(this.score, Math.min(...bars), Math.max(...bars)),
      () => {
        for (const beat of this.effectBeats()) {
          const masterBar = beat.voice.bar.masterBar;
          // alphaTab keeps a beat's fermata on the beat and in its master bar.
          if (off) {
            beat.fermata = null;
            masterBar.fermata?.delete(beat.playbackStart);
            if (masterBar.fermata?.size === 0) masterBar.fermata = null;
          } else if (!beat.fermata) {
            const fermata = new model.Fermata();
            fermata.type = model.FermataType.Medium;
            fermata.length = 1;
            beat.fermata = fermata;
            masterBar.addFermata(beat.playbackStart, fermata);
          }
        }
      },
      off ? "Fermata off" : "Fermata",
    );
  }

  /** Whether the cursor's bar starts or ends a repeat. */
  repeatState(side: "start" | "end"): boolean {
    const masterBar = this.score.masterBars[this._cursor.bar];
    if (!masterBar) return false;
    return side === "start" ? masterBar.isRepeatStart : masterBar.repeatCount > 0;
  }

  /** Opens or closes a repeat at the cursor's bar (a closing repeat plays twice). */
  toggleRepeat(side: "start" | "end") {
    const index = this._cursor.bar;
    const on = !this.repeatState(side);
    const what = side === "start" ? "repeat start" : "repeat end";
    this.run(
      on ? `Add ${what}` : `Remove ${what}`,
      () => masterBarContent(this.score, index),
      () => {
        const masterBar = this.score.masterBars[index]!;
        if (side === "start") masterBar.isRepeatStart = on;
        else masterBar.repeatCount = on ? 2 : 0;
      },
      on ? `${what[0]!.toUpperCase()}${what.slice(1)}` : `No ${what}`,
    );
  }

  /** Bends the cursor's note (or every selected note); null removes the bend. */
  setBend(points: readonly CurvePoint[] | null) {
    if (this.kind !== "stringed") return this.refuse("Bends are only available on tab tracks");
    const notes = this.effectNotes();
    if (notes.length === 0) return this.refuse("No note at the cursor");
    const had = notes.some((n) => n.hasBend);
    this.run(
      points ? (had ? "Change bend" : "Add bend") : "Remove bend",
      this.effectTargets,
      () => {
        for (const note of this.effectNotes()) setBend(note, points);
      },
      points ? "Bend" : "Bend off",
    );
  }

  /** Puts a whammy bar curve on the cursor's beat (or the selected beats); null removes it. */
  setWhammy(points: readonly CurvePoint[] | null) {
    if (this.kind !== "stringed")
      return this.refuse("The whammy bar is only available on tab tracks");
    const beats = this.effectBeats();
    if (beats.length === 0) return this.refuse("No notes on this beat");
    const had = beats.some((b) => b.hasWhammyBar);
    this.run(
      points ? (had ? "Change whammy bar" : "Add whammy bar") : "Remove whammy bar",
      this.effectTargets,
      () => {
        for (const beat of this.effectBeats()) setWhammy(beat, points);
      },
      points ? "Whammy bar" : "Whammy bar off",
    );
  }

  /**
   * Adds a grace note before the cursor's note (a copy of it, which can then
   * be changed), played before the beat or on it. Grace notes take no time in
   * the bar. On a grace note, changes how it is played; `GraceType.None`
   * turns it into a normal note.
   */
  setGrace(type: model.GraceType) {
    const beat = this.beatAt();
    if (!beat || isPlaceholder(beat) || beat.notes.length === 0) {
      return this.refuse("No note at the cursor");
    }
    if (beat.graceType !== GraceType.None) {
      if (type === beat.graceType) return;
      this.run(
        type === GraceType.None ? "Remove grace note" : "Change grace note",
        this.cursorTargets,
        () => {
          this.beatAt()!.graceType = type;
        },
        type === GraceType.None ? "Normal note" : graceText(type),
      );
      return;
    }
    if (type === GraceType.None) return;
    this.run(
      "Add grace note",
      this.cursorTargets,
      () => {
        const current = this.beatAt()!;
        const grace = newBeat(D.ThirtySecond);
        grace.graceType = type;
        const source = this.noteAtCursor(current) ?? current.notes[0]!;
        grace.addNote(plainNote(source));
        current.voice.beats.splice(current.index, 0, grace);
        // The cursor stays at this position: on the new grace note.
      },
      `${graceText(type)}: type its fret or pitch`,
    );
  }

  /** Writes free text above the cursor's beat (null or "" removes it). */
  setText(text: string | null) {
    const beat = this.beatAt();
    if (!beat || beat.isEmpty) return this.refuse("Text goes on a note or rest");
    const value = text?.trim() ? text.trim() : null;
    if ((beat.text ?? null) === value) return;
    this.run(
      value === null ? "Remove text" : beat.text ? "Change text" : "Add text",
      this.cursorTargets,
      () => {
        this.beatAt()!.text = value;
      },
      value === null ? "Text removed" : `Text: ${value}`,
    );
  }

  /** Writes a chord (name and diagram) on the cursor's beat; null removes it. */
  setChord(spec: ChordSpec | null) {
    const beat = this.beatAt();
    if (!beat || beat.isEmpty) return this.refuse("Chords go on a note or rest");
    if (!spec && !beat.chordId) return;
    this.run(
      spec ? (beat.chordId ? "Change chord" : "Add chord") : "Remove chord",
      () => [this.staff, ...barContent(this.bar())],
      () => setChord(this.beatAt()!, spec),
      spec ? `Chord ${spec.name}` : "Chord removed",
    );
  }

  /**
   * Runs a change to the song's structure (bars `from`–`to`, in every
   * track) as one undo step.
   */
  editBars(label: string, range: { from: number; to: number }, apply: () => void, message = label) {
    this.run(label, () => masterBarContent(this.score, range.from, range.to), apply, message);
  }

  /** Pitches of the selected beats (or the cursor's), for naming the chord they form. */
  selectedPitches(): number[] {
    const beats = this._selection ? this.selectedBeats() : [this.beatAt()];
    return beats.flatMap((beat) =>
      beat && !beat.isEmpty
        ? beat.notes.filter((n) => !n.isPercussion).map((n) => n.realValue)
        : [],
    );
  }

  // --- Clipboard ---------------------------------------------------------------

  copy() {
    const bars = this.selectedPositions()
      .map((positions) =>
        positions
          .map((p) => this.beatAt(p))
          .filter((beat): beat is Beat => beat !== null && !beat.isEmpty)
          .map((beat) => ({ beat: cloneBeat(beat), pitches: beat.notes.map(pitchOf) })),
      )
      .filter((beats) => beats.length > 0);
    const count = bars.flat().length;
    if (count === 0) return;
    this.clipboard = { kind: this.kind, bars };
    this._message = `Copied ${count} ${count === 1 ? "beat" : "beats"}`;
    this.emit("cursor");
  }

  cut() {
    this.copy();
    if (this.clipboard) this.clearNotes("Cut");
  }

  /**
   * Pastes over the music from the cursor on, bar by bar as it was copied
   * (the first copied bar at the cursor, the next ones at the start of the
   * following bars). Bars are added at the end of the song when needed.
   */
  paste() {
    const clipboard = this.clipboard;
    if (!clipboard) return;
    const start = { bar: this._cursor.bar, beat: this._cursor.beat };
    const barsNeeded = start.bar + clipboard.bars.length - this.staff.bars.length;
    const count = clipboard.bars.flat().length;
    this.run(
      "Paste",
      () => [
        ...this.structureTargets(),
        ...clipboard.bars.flatMap((_, i) => {
          const bar = this.staff.bars[start.bar + i];
          return bar ? [...barContent(bar)] : [];
        }),
        ...(this._cursor.voice < this.bar().voices.length ? [] : staffContent(this.staff)),
      ],
      () => {
        for (let i = 0; i < barsNeeded; i++) appendMasterBar(this.score);
        ensureVoices(this.staff, this._cursor.voice + 1);
        let end = start;
        clipboard.bars.forEach((copied, i) => {
          const bar = this.bar(start.bar + i);
          const voice = bar.voices[this._cursor.voice]!;
          const placeholder =
            voice.beats.length === 1 &&
            (voice.beats[0]!.isEmpty || voice.beats[0]!.notes.length === 0);
          const from = placeholder ? 0 : i === 0 ? start.beat : 0;
          const beats = copied.map((c) => this.convertBeat(c, clipboard.kind));
          voice.beats.splice(from, placeholder ? voice.beats.length : beats.length, ...beats);
          end = { bar: bar.index, beat: from + beats.length - 1 };
        });
        this._selection = { anchor: start, head: end };
        this._cursor.bar = end.bar;
        this._cursor.beat = end.beat;
      },
      `Pasted ${count} ${count === 1 ? "beat" : "beats"}`,
    );
  }

  /** A fresh copy of a copied beat, adapted to this track: tab ↔ staff by pitch, drums only onto drums. */
  private convertBeat({ beat, pitches }: CopiedBeat, from: TrackKind): Beat {
    const copy = cloneBeat(beat);
    const to = this.kind;
    const notes = [...copy.notes];
    for (const note of notes) copy.removeNote(note);
    notes.forEach((note, i) => {
      const pitch = pitches[i]!;
      if ((from === "drums") !== (to === "drums")) return;
      if (to === "drums") {
        copy.addNote(note);
      } else if (to === "pitched") {
        note.string = -1;
        note.fret = -1;
        note.octave = Math.floor(pitch / 12);
        note.tone = pitch % 12;
        copy.addNote(note);
      } else if (
        from === "stringed" &&
        note.string <= this.stringCount &&
        this.fits(pitch, note.string)
      ) {
        // Same string, same pitch where possible (e.g. between two guitars).
        note.fret = pitch - this.openPitch(note.string);
        copy.addNote(note);
      } else {
        const string = this.freeStringFor(pitch, copy);
        if (string === null) return;
        note.octave = -1;
        note.tone = -1;
        note.string = string;
        note.fret = pitch - this.openPitch(string);
        copy.addNote(note);
      }
    });
    return copy;
  }

  private fits(pitch: number, string: number): boolean {
    const fret = pitch - this.openPitch(string);
    return fret >= 0 && fret <= MAX_FRET;
  }

  private freeStringFor(pitch: number, beat: Beat): number | null {
    for (let string = this.stringCount; string >= 1; string--) {
      if (this.fits(pitch, string) && !beat.hasNoteOnString(string)) return string;
    }
    return null;
  }
}
