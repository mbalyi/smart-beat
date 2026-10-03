/**
 * Writes a score as a Guitar Pro 5 file (version 5.00).
 *
 * Written for Smart Beat from community descriptions of the `.gp5` layout and
 * checked by reading the result back with alphaTab (see `docs/file-formats.md`
 * for sources and the clean-room notes). GP5 cannot hold everything Smart Beat
 * can: what it leaves out is reported in `warnings`.
 */
import { model } from "@coderline/alphatab";

import { ByteWriter } from "@/lib/export/gp5/bytes";
import { DRUM_TAB_STRINGS, placeDrums } from "@/lib/score/drum-tab";
import { defaultEncoding, encodingFor, scoreStrings, sourceEncoding } from "@/lib/score/encoding";
import { beatTicks } from "@/lib/score/bar-duration";
import { lyricsOf, MAX_LYRIC_LINES } from "@/lib/score/lyrics";
import {
  drumNumber,
  type Bar,
  type Beat,
  type MasterBar,
  type Note,
  type Score,
  type Track,
} from "@/lib/score/model";
import { tempoAt } from "@/lib/score/structure";

/** A tempo change written in a mix table: its BPM and its name (may be empty). */
interface TempoChange {
  bpm: number;
  name: string;
}

const {
  AccentuationType,
  AutomationType,
  BrushType,
  Direction,
  DynamicValue,
  FadeType,
  GraceType,
  HarmonicType,
  PickStroke,
  Rasgueado,
  SlideInType,
  SlideOutType,
  TripletFeel,
  VibratoType,
} = model;

export const VERSION_TEXT = "FICHIER GUITAR PRO v5.00";

/** Most strings a GP5 track can have. */
export const MAX_GP5_STRINGS = 7;

/** Highest fret GP5 offers. */
const MAX_GP5_FRET = 24;

export interface Gp5Result {
  bytes: Uint8Array;
  /** What could not be saved exactly, in words for the user. */
  warnings: string[];
}

/** The order of the jump and target signs in the file: each holds the bar (1-based) it is in. */
const DIRECTION_ORDER = [
  Direction.TargetCoda,
  Direction.TargetDoubleCoda,
  Direction.TargetSegno,
  Direction.TargetSegnoSegno,
  Direction.TargetFine,
  Direction.JumpDaCapo,
  Direction.JumpDaCapoAlCoda,
  Direction.JumpDaCapoAlDoubleCoda,
  Direction.JumpDaCapoAlFine,
  Direction.JumpDalSegno,
  Direction.JumpDalSegnoAlCoda,
  Direction.JumpDalSegnoAlDoubleCoda,
  Direction.JumpDalSegnoAlFine,
  Direction.JumpDalSegnoSegno,
  Direction.JumpDalSegnoSegnoAlCoda,
  Direction.JumpDalSegnoSegnoAlDoubleCoda,
  Direction.JumpDalSegnoSegnoAlFine,
  Direction.JumpDaCoda,
  Direction.JumpDaDoubleCoda,
];

const TUPLET_NUMERATORS = new Set([3, 5, 6, 7, 9, 10, 11, 12, 13]);

type TrackKindOnDisk = "stringed" | "drums" | "keys";

/** How a track is laid out in the file. */
interface TrackPlan {
  track: Track;
  kind: TrackKindOnDisk;
  /** Open-string pitches as written, highest string first. */
  tuning: number[];
  name: string;
}

interface PlacedNote {
  note: Note;
  /** 0 = highest string. */
  fileString: number;
  fret: number;
}

/** A dropped or approximated item, reported once however often it happens. */
class Warnings {
  private readonly seen = new Set<string>();
  readonly list: string[] = [];
  add(message: string) {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    this.list.push(message);
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const trackLabel = (track: Track) => track.name.trim() || `Track ${track.index + 1}`;

function notesOf(track: Track): Note[] {
  return track.staves.flatMap((staff) =>
    staff.bars.flatMap((bar) =>
      bar.voices.flatMap((voice) =>
        voice.beats.flatMap((beat) => (beat.isEmpty ? [] : beat.notes)),
      ),
    ),
  );
}

/** Spreads seven virtual strings over the range of a keyboard track. */
function virtualTuning(track: Track): number[] {
  const pitches = notesOf(track)
    .filter((n) => !n.isPercussion)
    .map((n) => n.realValue);
  const low = pitches.length > 0 ? Math.max(0, Math.min(...pitches)) : 40;
  const high = pitches.length > 0 ? Math.max(...pitches) : 64;
  const spacing = clamp(Math.ceil((high - low - MAX_GP5_FRET) / (MAX_GP5_STRINGS - 1)), 3, 12);
  return Array.from(
    { length: MAX_GP5_STRINGS },
    (_, i) => low + spacing * (MAX_GP5_STRINGS - 1 - i),
  );
}

function planTrack(track: Track, warnings: Warnings): TrackPlan {
  const staff = track.staves[0]!;
  const name = trackLabel(track);
  if (track.isPercussion || staff.isPercussion) {
    return { track, kind: "drums", tuning: [0, 0, 0, 0, 0, 0], name };
  }
  const tuning = [...staff.stringTuning.tunings];
  if (tuning.length === 0) {
    warnings.add(
      `“${name}” has no strings: Guitar Pro 5 has no keyboard staff, so it is saved as a seven-string track without tablature.`,
    );
    return { track, kind: "keys", tuning: virtualTuning(track), name };
  }
  if (tuning.length > MAX_GP5_STRINGS) {
    warnings.add(
      `“${name}” has ${tuning.length} strings: Guitar Pro 5 has at most ${MAX_GP5_STRINGS}, so notes on the lowest string are left out.`,
    );
    tuning.length = MAX_GP5_STRINGS;
  }
  return { track, kind: "stringed", tuning, name };
}

const durationCode = (duration: model.Duration) => Math.round(Math.log2(duration)) - 2;

const dynamicCode = (dynamics: model.DynamicValue) =>
  dynamics >= DynamicValue.PPP && dynamics <= DynamicValue.FFF ? dynamics + 1 : 6;

/** Fret delta a harmonic value stands for (the reverse of alphaTab's mapping). */
function deltaFret(value: number): number {
  if (Math.abs(value - 2.4) < 0.01) return 2;
  if (Math.abs(value - 3.2) < 0.01) return 3;
  if (Math.abs(value - 8.2) < 0.01) return 8;
  if (Math.abs(value - 9.6) < 0.01) return 10;
  if (Math.abs(value - 14.7) < 0.01) return 14;
  if (Math.abs(value - 21.7) < 0.01) return 21;
  return Math.round(value);
}

function strokeCode(duration: number): number {
  if (duration >= 480) return 6;
  if (duration >= 240) return 5;
  if (duration >= 120) return 4;
  if (duration >= 60) return 3;
  return 2;
}

/** How eighth notes beam together, per beat of the bar (GP5 stores four groups). */
function beamGroups(masterBar: MasterBar): number[] {
  const { timeSignatureNumerator: n, timeSignatureDenominator: d } = masterBar;
  const group = d === 8 && n % 3 === 0 ? 3 : d === 2 ? 4 : 2;
  const groups = Math.max(1, Math.min(4, d === 8 ? n / group : n));
  return Array.from({ length: 4 }, (_, i) => (i < groups ? group : 0));
}

function graceBefore(all: readonly Beat[], beat: Beat): Beat | null {
  const before = all[all.indexOf(beat) - 1];
  return before && before.graceType !== GraceType.None ? before : null;
}

function graceTransition(grace: Note): number {
  if (grace.slideOutType === SlideOutType.Legato) return 1;
  if (grace.isHammerPullOrigin) return 3;
  return 0;
}

function harmonicTypeCode(type: model.HarmonicType): number {
  switch (type) {
    case HarmonicType.Natural:
    case HarmonicType.Feedback:
      return 1;
    case HarmonicType.Artificial:
      return 2;
    case HarmonicType.Tap:
      return 3;
    case HarmonicType.Pinch:
      return 4;
    case HarmonicType.Semi:
      return 5;
    default:
      return 0;
  }
}

/** A bend or whammy-bar curve: type, height, then offset/value pairs. */
function writeCurve(out: ByteWriter, points: readonly model.BendPoint[]) {
  const max = Math.max(...points.map((p) => p.value));
  const first = points[0]!.value;
  const last = points.at(-1)!.value;
  // 1 bend, 2 bend and release, 3 bend-release-bend, 4 pre-bend, 5 pre-bend and release
  const type = first > 0 ? (last < first ? 5 : 4) : max > last ? 2 : 1;
  out.u8(type);
  out.i32(max * 25);
  out.i32(points.length);
  for (const point of points)
    out
      .i32(point.offset)
      .i32(point.value * 25)
      .u8(0);
}

// --- The writer ---------------------------------------------------------------------------

class Gp5Writer {
  private readonly out: ByteWriter;
  private readonly warnings = new Warnings();
  private readonly plans: TrackPlan[];
  /** Tempo changes after the start, by `bar:beat` (beat of the first track's first voice). */
  private readonly tempoChanges = new Map<string, TempoChange>();

  private readonly score: Score;

  constructor(score: Score) {
    this.score = score;
    // The text is saved the way it was read (Guitar Pro 3–5 files), in a code page it fits in.
    this.out = new ByteWriter(
      encodingFor(scoreStrings(score), sourceEncoding(score) ?? defaultEncoding()),
    );
    this.plans = score.tracks.map((track) => planTrack(track, this.warnings));
    this.collectTempoChanges();
  }

  write(): Gp5Result {
    const { score, out } = this;
    out.fixedString(VERSION_TEXT, 30);
    this.writeInformation();
    this.writeLyrics();
    this.writePageSetup();
    out.intByteString(score.tempoLabel ?? ""); // tempo name (of the start tempo)
    out.i32(Math.round(tempoAt(score, 0)));
    out.i32(0); // key signature: stored per bar below
    out.u8(0); // octave
    this.writeChannels();
    this.writeDirections();
    out.i32(score.masterBars.length);
    out.i32(score.tracks.length);
    this.writeMasterBars();
    for (const plan of this.plans) this.writeTrack(plan);
    this.writeBars();
    if (out.lost > 0) {
      this.warnings.add(
        `${out.lost} character${out.lost === 1 ? "" : "s"} could not be saved in the ${out.encoding} text encoding and became “?”.`,
      );
    }
    return { bytes: out.toBytes(), warnings: this.warnings.list };
  }

  private writeInformation() {
    const { score, out } = this;
    for (const text of [
      score.title,
      score.subTitle,
      score.artist,
      score.album,
      score.words,
      score.music,
      score.copyright,
      score.tab,
      score.instructions,
    ]) {
      out.intByteString(text ?? "");
    }
    const notices = score.notices ? score.notices.split(/\r?\n/) : [];
    out.i32(notices.length);
    for (const line of notices) out.intByteString(line);
  }

  private writeLyrics() {
    const { out } = this;
    const written = this.plans.map((p) => lyricsOf(p.track).filter((l) => l.text.trim() !== ""));
    const index = written.findIndex((lines) => lines.length > 0);
    if (written.filter((lines) => lines.length > 0).length > 1) {
      this.warnings.add(
        "Guitar Pro 5 keeps the lyrics of one track only: the lyrics of the other tracks are left out.",
      );
    }
    out.i32(index + 1);
    const lines = index >= 0 ? lyricsOf(this.plans[index]!.track) : [];
    for (let i = 0; i < MAX_LYRIC_LINES; i++) {
      const line = lines[i];
      out.i32(line ? line.startBar + 1 : 1);
      out.intString(line?.text ?? "");
    }
  }

  private writePageSetup() {
    const { out } = this;
    // Page size and margins in millimetres, then the score size in percent.
    for (const value of [210, 297, 10, 10, 15, 10, 100]) out.i32(value);
    out.i16(0xff); // which header and footer items are shown
    for (const text of [
      "%TITLE%",
      "%SUBTITLE%",
      "%ARTIST%",
      "%ALBUM%",
      "Words by %WORDS%",
      "Music by %MUSIC%",
      "Words & Music by %WORDSMUSIC%",
      "Copyright %COPYRIGHT%",
      "All Rights Reserved - International Copyright Secured",
      "Page %N%/%P%",
    ]) {
      out.intByteString(text);
    }
  }

  /** The 64 MIDI channels (4 ports of 16): each track's channels carry its sound and mix. */
  private writeChannels() {
    const slots = Array.from({ length: 64 }, () => ({ program: 0, volume: 13, balance: 8 }));
    for (const { track } of this.plans) {
      const info = track.playbackInfo;
      for (const channel of [info.primaryChannel, info.secondaryChannel]) {
        if (channel < 0 || channel > 15) continue;
        slots[channel] = {
          program: info.program,
          volume: clamp(info.volume, 0, 16),
          balance: clamp(info.balance, 0, 16),
        };
      }
    }
    for (const slot of slots) {
      this.out.i32(slot.program).u8(slot.volume).u8(slot.balance);
      this.out.zeros(6); // chorus, reverb, phaser, tremolo, two unused
    }
  }

  private writeDirections() {
    const { out, score } = this;
    for (const direction of DIRECTION_ORDER) {
      const bar = score.masterBars.findIndex((m) => m.directions?.has(direction));
      out.i16(bar < 0 ? -1 : bar + 1);
    }
    out.i32(0); // master reverb
  }

  // --- Bars -----------------------------------------------------------------------------

  private writeMasterBars() {
    const { score, out } = this;
    let previous: MasterBar | null = null;
    for (const masterBar of score.masterBars) {
      const sectionText = masterBar.section?.text?.trim() ?? "";
      const timeChanged =
        !previous ||
        previous.timeSignatureNumerator !== masterBar.timeSignatureNumerator ||
        previous.timeSignatureDenominator !== masterBar.timeSignatureDenominator;
      const keyChanged =
        !previous ||
        previous.keySignature !== masterBar.keySignature ||
        previous.keySignatureType !== masterBar.keySignatureType;
      let flags = 0;
      if (timeChanged) flags |= 0x01 | 0x02;
      if (masterBar.isRepeatStart) flags |= 0x04;
      if (masterBar.repeatCount > 0) flags |= 0x08;
      if (sectionText) flags |= 0x20;
      if (keyChanged) flags |= 0x40;
      if (masterBar.isDoubleBar) flags |= 0x80;
      out.u8(flags);
      if (timeChanged)
        out.u8(masterBar.timeSignatureNumerator).u8(masterBar.timeSignatureDenominator);
      if (masterBar.repeatCount > 0) out.u8(masterBar.repeatCount);
      if (sectionText) out.intByteString(sectionText).u8(255).u8(0).u8(0).u8(0);
      if (keyChanged) out.i8(masterBar.keySignature).u8(masterBar.keySignatureType);
      if (timeChanged) out.bytes(beamGroups(masterBar));
      out.u8(masterBar.alternateEndings);
      out.u8(
        masterBar.tripletFeel === TripletFeel.Triplet8th
          ? 1
          : masterBar.tripletFeel === TripletFeel.Triplet16th
            ? 2
            : 0,
      );
      out.u8(0);
      if (
        ![TripletFeel.NoTripletFeel, TripletFeel.Triplet8th, TripletFeel.Triplet16th].includes(
          masterBar.tripletFeel,
        )
      ) {
        this.warnings.add(
          "Some triplet feels (dotted, Scottish) are not in Guitar Pro 5 and are left out.",
        );
      }
      previous = masterBar;
    }
  }

  private writeTrack(plan: TrackPlan) {
    const { out } = this;
    const { track } = plan;
    const info = track.playbackInfo;
    const staff = track.staves[0]!;
    let flags = 0x08; // visible
    if (plan.kind === "drums") flags |= 0x01;
    if (info.isSolo) flags |= 0x10;
    if (info.isMute) flags |= 0x20;
    out.u8(flags);
    out.fixedString(plan.name, 40);
    out.i32(plan.tuning.length);
    for (let i = 0; i < 7; i++) out.i32(plan.tuning[i] ?? 0);
    out.i32(1); // port
    out.i32(clamp(info.primaryChannel, 0, 15) + 1);
    out.i32(clamp(info.secondaryChannel, 0, 15) + 1);
    out.i32(MAX_GP5_FRET);
    out.i32(plan.kind === "stringed" ? staff.capo : 0);
    out.zeros(4); // colour
    // Drum tracks are shown with their drum tab (score + tab), as Guitar Pro does.
    const showTab = plan.kind === "drums" || (plan.kind === "stringed" && staff.showTablature);
    const showScore = plan.kind !== "stringed" || staff.showStandardNotation || !showTab;
    out.u8((showTab ? 1 : 0) | (showScore ? 2 : 0));
    out.u8(0).u8(0); // auto let ring, auto brush
    out.u8(0); // sound bank
    out.u8(0);
    out.i32(0);
    out.i32(0);
    out.i32(0);
    out.zeros(10);
    out.u8(0).u8(0);
    out.zeros(16); // realistic sound engine bank and effect
  }

  private collectTempoChanges() {
    const first = this.score.tracks[0]?.staves[0];
    this.score.masterBars.forEach((masterBar, barIndex) => {
      for (const automation of masterBar.tempoAutomations) {
        if (automation.type !== AutomationType.Tempo) continue;
        if (barIndex === 0 && automation.ratioPosition === 0) continue; // the song's start tempo
        const voice = first?.bars[barIndex]?.voices[0];
        if (!voice || voice.beats.length === 0) continue;
        const target = automation.ratioPosition * masterBar.calculateDuration() + 0.5;
        let start = 0;
        let chosen = 0;
        let position = 0;
        for (const beat of voice.beats) {
          if (beat.graceType !== GraceType.None) continue;
          if (start <= target) chosen = position;
          start += beatTicks(beat);
          position++;
        }
        this.tempoChanges.set(`${barIndex}:${chosen}`, {
          bpm: Math.round(automation.value),
          name: automation.text ?? "",
        });
      }
    });
  }

  private writeBars() {
    this.score.masterBars.forEach((_masterBar, barIndex) => {
      this.plans.forEach((plan, trackIndex) => {
        const bar = plan.track.staves[0]?.bars[barIndex];
        this.writeBar(plan, bar ?? null, barIndex, trackIndex);
      });
    });
  }

  private writeBar(plan: TrackPlan, bar: Bar | null, barIndex: number, trackIndex: number) {
    const { out } = this;
    out.u8(0);
    for (let v = 0; v < 2; v++) {
      const voice = bar?.voices[v];
      const beats = (voice?.beats ?? []).filter((beat) => beat.graceType === GraceType.None);
      // A second voice that holds nothing is not written.
      const empty = !voice || beats.length === 0 || (v > 0 && beats.every((beat) => beat.isEmpty));
      if (empty) {
        out.i32(0);
        continue;
      }
      out.i32(beats.length);
      beats.forEach((beat, i) => {
        const tempo =
          trackIndex === 0 && v === 0 ? this.tempoChanges.get(`${barIndex}:${i}`) : undefined;
        this.writeBeat(plan, beat, graceBefore(voice.beats, beat), tempo);
      });
    }
    if ((bar?.voices.length ?? 0) > 2) {
      this.warnings.add("Guitar Pro 5 has two voices per bar: further voices are left out.");
    }
  }

  private writeBeat(
    plan: TrackPlan,
    beat: Beat,
    graceBeat: Beat | null,
    tempo: TempoChange | undefined,
  ) {
    const { out } = this;
    const notes = this.placeNotes(plan, beat);
    const chord = beat.chordId ? beat.chord : null;
    const mix = this.mixChange(beat, tempo);
    const effects = this.beatEffects(beat);
    // Files read from Guitar Pro 3–5 mark "no tuplet" with -1.
    const tupleted =
      beat.tupletNumerator > 1 &&
      beat.tupletDenominator > 0 &&
      beat.tupletNumerator !== beat.tupletDenominator;
    const writeTuplet = tupleted && TUPLET_NUMERATORS.has(beat.tupletNumerator);
    if (beat.dots > 1) {
      this.warnings.add(
        "Double-dotted notes are not in Guitar Pro 5: they are saved with one dot.",
      );
    }
    if (tupleted && !writeTuplet) {
      this.warnings.add(
        `Tuplets of ${beat.tupletNumerator} are not in Guitar Pro 5 and are saved as plain notes.`,
      );
    }
    if (beat.duration > 64) this.warnings.add("Notes shorter than a 64th are saved as 64ths.");

    let flags = 0;
    if (beat.dots > 0) flags |= 0x01;
    if (chord) flags |= 0x02;
    if (beat.text) flags |= 0x04;
    if (effects) flags |= 0x08;
    if (mix) flags |= 0x10;
    if (writeTuplet) flags |= 0x20;
    // Status: 0 = empty (nothing written), 2 = rest. Beats with notes have none.
    const status = beat.isEmpty ? 0 : notes.length === 0 ? 2 : -1;
    if (status >= 0) flags |= 0x40;
    out.u8(flags);
    if (status >= 0) out.u8(status);
    out.i8(durationCode(Math.min(beat.duration, 64)));
    if (writeTuplet) out.i32(beat.tupletNumerator);
    if (chord) this.writeChord(plan, chord);
    if (beat.text) out.intByteString(beat.text);
    if (effects) effects(out);
    if (mix) mix(out);

    let stringFlags = 0;
    for (const { fileString } of notes) stringFlags |= 1 << (6 - fileString);
    out.u8(stringFlags);
    const ordered = [...notes].sort((a, b) => a.fileString - b.fileString);
    ordered.forEach((placed, i) => {
      this.writeNote(plan, placed, i === 0 ? graceBeat : null, i === 0 ? beat : null);
    });
    out.i16(0); // beam and ottava flags
  }

  /** Where each note of a beat goes in the file: string index 0 = highest string. */
  private placeNotes(plan: TrackPlan, beat: Beat): PlacedNote[] {
    if (beat.isEmpty) return [];
    const placed: PlacedNote[] = [];
    const used = new Set<number>();
    if (plan.kind === "drums") {
      // Each drum on its line of the drum tab (#53): line 6 (top) is file string 0.
      const lines = placeDrums(beat.notes.filter((n) => n.isPercussion));
      if (lines.size < beat.notes.length) {
        this.warnings.add("More than six drums at once: extra drum notes are left out.");
      }
      for (const [note, line] of lines) {
        placed.push({ note, fileString: DRUM_TAB_STRINGS - line, fret: drumNumber(note) });
      }
      return placed;
    }
    if (plan.kind === "stringed") {
      const strings = plan.track.staves[0]!.stringTuning.tunings.length;
      for (const note of beat.notes) {
        if (!note.isStringed) continue;
        const fileString = strings - note.string;
        if (fileString < 0 || fileString >= plan.tuning.length || used.has(fileString)) {
          this.warnings.add(
            `Some notes of “${plan.name}” could not be saved (no string for them).`,
          );
          continue;
        }
        if (note.fret > MAX_GP5_FRET) {
          this.warnings.add(
            `Frets above ${MAX_GP5_FRET} are not in Guitar Pro 5: those notes are left out.`,
          );
          continue;
        }
        used.add(fileString);
        placed.push({ note, fileString, fret: note.fret });
      }
      return placed;
    }
    // Keyboards: spread the pitches over the virtual strings, high notes on high strings.
    const pitched = beat.notes
      .filter((n) => !n.isPercussion)
      .sort((a, b) => b.realValue - a.realValue);
    for (const note of pitched) {
      let best: { fileString: number; fret: number } | null = null;
      plan.tuning.forEach((open, fileString) => {
        const fret = note.realValue - open;
        if (used.has(fileString) || fret < 0 || fret > MAX_GP5_FRET) return;
        if (!best || fret < best.fret) best = { fileString, fret };
      });
      if (!best) {
        this.warnings.add(
          `Some chords of “${plan.name}” have more notes than Guitar Pro 5 can hold: extra notes are left out.`,
        );
        continue;
      }
      const { fileString, fret } = best as { fileString: number; fret: number };
      used.add(fileString);
      placed.push({ note, fileString, fret });
    }
    return placed;
  }

  private writeChord(plan: TrackPlan, chord: model.Chord) {
    const { out } = this;
    out.u8(1).zeros(16); // header (new format), then sharp, root, type... left at defaults
    out.fixedString(chord.name ?? "", 21);
    out.zeros(4);
    out.i32(chord.firstFret ?? 1);
    for (let i = 0; i < 7; i++) out.i32(i < plan.tuning.length ? (chord.strings[i] ?? -1) : -1);
    const barres = (chord.barreFrets ?? []).slice(0, 5);
    out.u8(barres.length);
    for (let i = 0; i < 5; i++) out.u8(barres[i] ?? 0);
    out.zeros(26);
  }

  /** Beat-level effects, or null when there are none. */
  private beatEffects(beat: Beat): ((out: ByteWriter) => void) | null {
    let flags = 0;
    let flags2 = 0;
    const slap = beat.tap ? 1 : beat.slap ? 2 : beat.pop ? 3 : 0;
    const brush =
      beat.brushType === BrushType.BrushUp || beat.brushType === BrushType.ArpeggioUp
        ? "up"
        : beat.brushType === BrushType.BrushDown || beat.brushType === BrushType.ArpeggioDown
          ? "down"
          : null;
    const whammy =
      beat.whammyBarPoints && beat.whammyBarPoints.length > 0 ? beat.whammyBarPoints : null;
    if (beat.vibrato !== VibratoType.None) flags |= 0x02;
    if (beat.fade === FadeType.FadeIn) flags |= 0x10;
    if (slap) flags |= 0x20;
    if (brush) flags |= 0x40;
    if (beat.rasgueado !== Rasgueado.None) flags2 |= 0x01;
    if (beat.pickStroke !== PickStroke.None) flags2 |= 0x02;
    if (whammy) flags2 |= 0x04;
    if (flags === 0 && flags2 === 0) return null;
    return (out) => {
      out.u8(flags).u8(flags2);
      if (slap) out.i8(slap);
      if (whammy) writeCurve(out, whammy);
      if (brush) {
        const value = strokeCode(beat.brushDuration);
        // GP5 stores the upstroke first, then the downstroke.
        out.u8(brush === "up" ? value : 0).u8(brush === "down" ? value : 0);
      }
      if (flags2 & 0x02) out.i8(beat.pickStroke === PickStroke.Up ? 1 : 2);
    };
  }

  /** A mix table change for tempo, instrument, volume and balance changes on the beat. */
  private mixChange(
    beat: Beat,
    tempo: TempoChange | undefined,
  ): ((out: ByteWriter) => void) | null {
    const volume = beat.getAutomation(AutomationType.Volume);
    const balance = beat.getAutomation(AutomationType.Balance);
    const instrument = beat.getAutomation(AutomationType.Instrument);
    if (!volume && !balance && !instrument && tempo === undefined) return null;
    return (out) => {
      out.i8(instrument ? instrument.value : -1);
      out.zeros(16); // realistic sound engine bank
      out.i8(volume ? volume.value : -1);
      out.i8(balance ? balance.value : -1);
      out.i8(-1).i8(-1).i8(-1).i8(-1); // chorus, reverb, phaser, tremolo
      out.intByteString(tempo?.name ?? ""); // tempo name ("Allegro", "Breakdown"…)
      out.i32(tempo?.bpm ?? -1);
      if (volume) out.u8(0);
      if (balance) out.u8(0);
      if (tempo !== undefined) out.i8(0);
      out.u8(0); // applies to all tracks: no
      out.i8(-1); // wah pedal
    };
  }

  private writeNote(
    plan: TrackPlan,
    placed: PlacedNote,
    graceBeat: Beat | null,
    beat: Beat | null,
  ) {
    const { out } = this;
    const { note, fret } = placed;
    const effects = this.noteEffects(plan, placed, graceBeat, beat);
    const dynamic = note.dynamics !== DynamicValue.F;
    const fullDuration = note.durationPercent === 1;

    let flags = 0x20; // type and fret follow
    if (!fullDuration) flags |= 0x01;
    if (note.accentuated === AccentuationType.Heavy) flags |= 0x02;
    if (note.isGhost) flags |= 0x04;
    if (effects) flags |= 0x08;
    if (dynamic) flags |= 0x10;
    if (note.accentuated === AccentuationType.Normal) flags |= 0x40;
    out.u8(flags);
    out.u8(note.isTieDestination ? 2 : note.isDead ? 3 : 1);
    if (dynamic) out.i8(dynamicCode(note.dynamics));
    out.i8(fret);
    if (!fullDuration) out.f64BE(note.durationPercent);
    out.u8(0); // accidentals are not swapped
    if (effects) effects(out);
  }

  private noteEffects(
    plan: TrackPlan,
    placed: PlacedNote,
    graceBeat: Beat | null,
    beat: Beat | null,
  ): ((out: ByteWriter) => void) | null {
    if (plan.kind === "drums") return null;
    const { note } = placed;
    const bend = note.bendPoints && note.bendPoints.length > 0 ? note.bendPoints : null;
    const grace = graceBeat?.notes[0] ?? null;
    // GP5 keeps tremolo picking with a note: the first one of the beat.
    const tremolo = beat?.tremoloPicking ?? null;
    const slideOut =
      note.slideOutType === SlideOutType.Shift
        ? 1
        : note.slideOutType === SlideOutType.Legato
          ? 2
          : note.slideOutType === SlideOutType.OutDown
            ? 4
            : note.slideOutType === SlideOutType.OutUp
              ? 8
              : 0;
    const slideIn =
      note.slideInType === SlideInType.IntoFromBelow
        ? 16
        : note.slideInType === SlideInType.IntoFromAbove
          ? 32
          : 0;
    const slide = slideOut | slideIn;
    const harmonicCode = plan.kind === "stringed" ? harmonicTypeCode(note.harmonicType) : 0;
    const trill = plan.kind === "stringed" && note.isTrill;

    let flags = 0;
    let flags2 = 0;
    if (bend) flags |= 0x01;
    if (note.isHammerPullOrigin) flags |= 0x02;
    if (note.isLetRing) flags |= 0x08;
    if (grace) flags |= 0x10;
    if (note.isStaccato) flags2 |= 0x01;
    if (note.isPalmMute) flags2 |= 0x02;
    if (tremolo) flags2 |= 0x04;
    if (slide) flags2 |= 0x08;
    if (harmonicCode) flags2 |= 0x10;
    if (trill) flags2 |= 0x20;
    if (note.vibrato !== VibratoType.None) flags2 |= 0x40;
    if (flags === 0 && flags2 === 0) return null;
    if (note.harmonicType === HarmonicType.Feedback) {
      this.warnings.add("Feedback harmonics are saved as natural harmonics.");
    }

    return (out) => {
      out.u8(flags).u8(flags2);
      if (bend) writeCurve(out, bend);
      if (grace && graceBeat) {
        out.i8(grace.fret);
        out.i8(dynamicCode(graceBeat.dynamics));
        out.u8(graceTransition(grace));
        out.u8(1);
        out.u8((grace.isDead ? 1 : 0) | (graceBeat.graceType === GraceType.OnBeat ? 2 : 0));
      }
      if (tremolo) out.u8(tremolo.marks);
      if (slide) out.u8(slide);
      if (harmonicCode) this.writeHarmonic(out, note, harmonicCode);
      if (trill) {
        out.u8(note.trillValue - note.stringTuning);
        out.u8(note.trillSpeed === 64 ? 3 : note.trillSpeed === 32 ? 2 : 1);
      }
    };
  }

  private writeHarmonic(out: ByteWriter, note: Note, code: number) {
    out.u8(code);
    const delta = deltaFret(note.harmonicValue);
    if (code === 2) {
      const played = (((note.fret + note.stringTuning) % 12) + 12) % 12;
      const tone = (played + delta) % 12;
      const base = (tone - played + 12) % 12;
      const octaves = Math.max(0, Math.round((delta - base) / 12));
      out.u8(tone).u8(0).u8(octaves);
    } else if (code === 3) {
      out.u8(delta);
    }
  }
}

/** Writes `score` as a Guitar Pro 5 file. */
export function writeGp5(score: Score): Gp5Result {
  return new Gp5Writer(score).write();
}
