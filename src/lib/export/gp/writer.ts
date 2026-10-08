/**
 * Writes a score as a Guitar Pro 5, 4 or 3 file (versions 5.00, 4.06 and 3.00).
 *
 * Written for Smart Beat from community descriptions of the `.gp3`, `.gp4` and
 * `.gp5` layouts and checked by reading the result back with alphaTab (see
 * `docs/file-formats.md` for sources and the clean-room notes). The three
 * generations share most of their layout; where they differ the writer
 * branches on `version`. The older ones cannot hold everything Smart Beat can:
 * what a format leaves out is reported in `warnings`.
 */
import { model } from "@coderline/alphatab";

import { ByteWriter } from "@/lib/export/gp/bytes";
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

/** The Guitar Pro generations the writer produces. */
export type GpVersion = 3 | 4 | 5;

const VERSION_TEXTS: Record<GpVersion, string> = {
  3: "FICHIER GUITAR PRO v3.00",
  4: "FICHIER GUITAR PRO v4.06",
  5: "FICHIER GUITAR PRO v5.00",
};

/** The name of each generation, for the warnings. */
const PRODUCTS: Record<GpVersion, string> = {
  3: "Guitar Pro 3",
  4: "Guitar Pro 4",
  5: "Guitar Pro 5",
};

/** Most strings a track can have (all three generations). */
export const MAX_STRINGS = 7;

/** Highest fret Guitar Pro offers. */
const MAX_FRET = 24;

export interface GpResult {
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

/**
 * The tuplets Guitar Pro 3–5 can store: they write only the number of notes
 * and read the time they take back from it (3 in the time of 2, 5 to 7 in the
 * time of 4, 9 to 13 in the time of 8). Any other ratio, like a nested 9:4,
 * would come back as a different rhythm.
 */
const GP_TUPLET_TIME = new Map([
  [3, 2],
  [5, 4],
  [6, 4],
  [7, 4],
  [9, 8],
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
]);

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
  const spacing = clamp(Math.ceil((high - low - MAX_FRET) / (MAX_STRINGS - 1)), 3, 12);
  return Array.from({ length: MAX_STRINGS }, (_, i) => low + spacing * (MAX_STRINGS - 1 - i));
}

function planTrack(track: Track, warnings: Warnings, product: string): TrackPlan {
  const staff = track.staves[0]!;
  const name = trackLabel(track);
  if (track.isPercussion || staff.isPercussion) {
    return { track, kind: "drums", tuning: [0, 0, 0, 0, 0, 0], name };
  }
  const tuning = [...staff.stringTuning.tunings];
  if (tuning.length === 0) {
    warnings.add(
      `“${name}” has no strings: ${product} has no keyboard staff, so it is saved as a seven-string track without tablature.`,
    );
    return { track, kind: "keys", tuning: virtualTuning(track), name };
  }
  if (tuning.length > MAX_STRINGS) {
    warnings.add(
      `“${name}” has ${tuning.length} strings: ${product} has at most ${MAX_STRINGS}, so notes on the lowest string are left out.`,
    );
    tuning.length = MAX_STRINGS;
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

class GpWriter {
  private readonly out: ByteWriter;
  private readonly warnings = new Warnings();
  private readonly plans: TrackPlan[];
  /** Tempo changes after the start, by `bar:beat` (beat of the first track's first voice). */
  private readonly tempoChanges = new Map<string, TempoChange>();

  private readonly score: Score;
  private readonly version: GpVersion;
  /** The name of the generation being written, for the warnings. */
  private readonly product: string;

  constructor(score: Score, version: GpVersion) {
    this.score = score;
    this.version = version;
    this.product = PRODUCTS[version];
    // The text is saved the way it was read (Guitar Pro 3–5 files), in a code page it fits in.
    this.out = new ByteWriter(
      encodingFor(scoreStrings(score), sourceEncoding(score) ?? defaultEncoding()),
    );
    this.plans = score.tracks.map((track) => planTrack(track, this.warnings, this.product));
    this.collectTempoChanges();
  }

  write(): GpResult {
    const { score, out, version } = this;
    out.fixedString(VERSION_TEXTS[version], 30);
    this.writeInformation();
    // Before Guitar Pro 5 the triplet feel is one setting for the whole song.
    if (version < 5) out.bool(this.songTripletFeel());
    if (version >= 4) this.writeLyrics();
    else this.warnLostLyrics();
    if (version >= 5) {
      this.writePageSetup();
      out.intByteString(score.tempoLabel ?? ""); // tempo name (of the start tempo)
    } else if (score.tempoLabel || this.tempoNames()) {
      this.warnings.add(`${this.product} has no tempo names: they are left out.`);
    }
    out.i32(Math.round(tempoAt(score, 0)));
    out.i32(0); // key signature: stored per bar below
    if (version >= 4) out.u8(0); // octave
    this.writeChannels();
    if (version >= 5) this.writeDirections();
    else this.warnLostDirections();
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
    // Before Guitar Pro 5 one field holds the words and the music credit.
    const credits =
      this.version >= 5 ? [score.words, score.music] : [score.words || score.music || ""];
    if (this.version < 5 && score.words && score.music && score.words !== score.music) {
      this.warnings.add(
        `${this.product} has one field for the words and music credits: the music credit is left out.`,
      );
    }
    for (const text of [
      score.title,
      score.subTitle,
      score.artist,
      score.album,
      ...credits,
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
        `${this.product} keeps the lyrics of one track only: the lyrics of the other tracks are left out.`,
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

  /** Guitar Pro 3 has no lyrics. */
  private warnLostLyrics() {
    if (this.plans.some((p) => lyricsOf(p.track).some((l) => l.text.trim() !== ""))) {
      this.warnings.add(`${this.product} has no lyrics: they are left out.`);
    }
  }

  /** Coda, segno and da capo signs are Guitar Pro 5 only. */
  private warnLostDirections() {
    if (this.score.masterBars.some((m) => (m.directions?.size ?? 0) > 0)) {
      this.warnings.add(
        `${this.product} has no jumps (Coda, Segno, D.C., D.S.): they are left out.`,
      );
    }
  }

  /** The triplet feel of the whole song, for the generations that have no feel per bar. */
  private songTripletFeel(): boolean {
    const feels = this.score.masterBars.map((m) => m.tripletFeel);
    const first = feels[0] ?? TripletFeel.NoTripletFeel;
    if (
      feels.some((feel) => feel !== first) ||
      ![TripletFeel.NoTripletFeel, TripletFeel.Triplet8th].includes(first)
    ) {
      this.warnings.add(
        `${this.product} has one triplet feel for the whole song: the feel of the first bar is used, and it can only be the triplet eighth feel.`,
      );
    }
    return first === TripletFeel.Triplet8th;
  }

  /** Whether any tempo change in the song has a name. */
  private tempoNames(): boolean {
    return [...this.tempoChanges.values()].some((change) => change.name !== "");
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
    const legacy = this.version < 5;
    let previous: MasterBar | null = null;
    score.masterBars.forEach((masterBar, barIndex) => {
      const sectionText = masterBar.section?.text?.trim() ?? "";
      const timeChanged =
        !previous ||
        previous.timeSignatureNumerator !== masterBar.timeSignatureNumerator ||
        previous.timeSignatureDenominator !== masterBar.timeSignatureDenominator;
      const keyChanged =
        !previous ||
        previous.keySignature !== masterBar.keySignature ||
        previous.keySignatureType !== masterBar.keySignatureType;
      // Before Guitar Pro 5 the endings are stored as a number, not as a set of bits.
      const ending = legacy && masterBar.alternateEndings !== 0 ? this.legacyEnding(barIndex) : 0;
      let flags = 0;
      if (timeChanged) flags |= 0x01 | 0x02;
      if (masterBar.isRepeatStart) flags |= 0x04;
      if (masterBar.repeatCount > 0) flags |= 0x08;
      if (ending > 0) flags |= 0x10;
      if (sectionText) flags |= 0x20;
      if (keyChanged) flags |= 0x40;
      if (masterBar.isDoubleBar) flags |= 0x80;
      out.u8(flags);
      if (timeChanged)
        out.u8(masterBar.timeSignatureNumerator).u8(masterBar.timeSignatureDenominator);
      // Guitar Pro 3 and 4 store how many times the bars are repeated, not how often they play.
      if (masterBar.repeatCount > 0)
        out.u8(legacy ? masterBar.repeatCount - 1 : masterBar.repeatCount);
      if (ending > 0) out.u8(ending);
      if (sectionText) out.intByteString(sectionText).u8(255).u8(0).u8(0).u8(0);
      if (keyChanged) out.i8(masterBar.keySignature).u8(masterBar.keySignatureType);
      if (!legacy) {
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
            `Some triplet feels (dotted, Scottish) are not in ${this.product} and are left out.`,
          );
        }
      }
      previous = masterBar;
    });
  }

  /**
   * The ending number Guitar Pro 3 and 4 store for the alternate endings of
   * bar `index` (0 when they cannot be stored). A number N stands for the
   * endings 1 to N that no earlier bar of the same repeat has: how Guitar Pro 3
   * and 4 files are read (alphaTab's reader included).
   */
  private legacyEnding(index: number): number {
    const { masterBars } = this.score;
    const wanted = masterBars[index]!.alternateEndings;
    let used = 0;
    for (let i = index - 1; i >= 0; i--) {
      const earlier = masterBars[i]!;
      if (earlier.repeatCount > 0 && i !== index - 1) break;
      if (earlier.isRepeatStart) break;
      used |= earlier.alternateEndings;
    }
    const number = 32 - Math.clz32(wanted);
    let covered = 0;
    for (let bit = 0; bit < number; bit++) if ((used & (1 << bit)) === 0) covered |= 1 << bit;
    if (number > 8 || covered !== wanted) {
      this.warnings.add(
        `Some alternate endings cannot be written in ${this.product} (they skip a number): they are left out.`,
      );
      return 0;
    }
    return number;
  }

  private writeTrack(plan: TrackPlan) {
    const { out } = this;
    const { track } = plan;
    const info = track.playbackInfo;
    const staff = track.staves[0]!;
    const legacy = this.version < 5;
    let flags = legacy ? 0 : 0x08; // visible
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
    out.i32(MAX_FRET);
    out.i32(plan.kind === "stringed" ? staff.capo : 0);
    out.zeros(4); // colour
    // Guitar Pro 3 and 4 always show both the score and the tablature.
    if (legacy) return;
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
    const { out, version } = this;
    // Guitar Pro 5 has two voices per bar; 3 and 4 have one.
    const voices = version >= 5 ? 2 : 1;
    if (version >= 5) out.u8(0);
    for (let v = 0; v < voices; v++) {
      const voice = bar?.voices[v];
      const beats = (voice?.beats ?? []).filter((beat) => beat.graceType === GraceType.None);
      // A second voice that holds nothing is not written.
      const empty = !voice || beats.length === 0 || (v > 0 && beats.every((beat) => beat.isEmpty));
      if (empty) {
        // The only voice of a bar must have a beat.
        if (version < 5) this.writeEmptyBeat();
        else out.i32(0);
        continue;
      }
      out.i32(beats.length);
      beats.forEach((beat, i) => {
        const tempo =
          trackIndex === 0 && v === 0 ? this.tempoChanges.get(`${barIndex}:${i}`) : undefined;
        this.writeBeat(plan, beat, graceBefore(voice.beats, beat), tempo);
      });
    }
    const extra = (bar?.voices ?? [])
      .slice(voices)
      .some((voice) => voice.beats.some((beat) => !beat.isEmpty));
    if (version >= 5 && (bar?.voices.length ?? 0) > 2) {
      this.warnings.add("Guitar Pro 5 has two voices per bar: further voices are left out.");
    } else if (version < 5 && extra) {
      this.warnings.add(
        `${this.product} has one voice per bar: the notes of the other voices are left out.`,
      );
    }
  }

  /** A bar without beats: one empty beat, which is what Guitar Pro 3 and 4 expect there. */
  private writeEmptyBeat() {
    const { out } = this;
    out.i32(1);
    out.u8(0x40).u8(0); // status: empty
    out.i8(durationCode(4));
    out.u8(0); // no notes
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
    const writeTuplet =
      tupleted && GP_TUPLET_TIME.get(beat.tupletNumerator) === beat.tupletDenominator;
    if (beat.dots > 1) {
      this.warnings.add(
        `Double-dotted notes are not in ${this.product}: they are saved with one dot.`,
      );
    }
    if (tupleted && !writeTuplet) {
      const time = GP_TUPLET_TIME.get(beat.tupletNumerator);
      this.warnings.add(
        time === undefined
          ? `Tuplets of ${beat.tupletNumerator} are not in ${this.product} and are saved as plain notes.`
          : `The ${beat.tupletNumerator}:${beat.tupletDenominator} tuplet is not in ${this.product}, which only has ${beat.tupletNumerator} notes in the time of ${time}: it is saved as plain notes.`,
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
    if (this.version >= 5) out.i16(0); // beam and ottava flags
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
        if (note.fret > MAX_FRET) {
          this.warnings.add(
            `Frets above ${MAX_FRET} are not in ${this.product}: those notes are left out.`,
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
        if (used.has(fileString) || fret < 0 || fret > MAX_FRET) return;
        if (!best || fret < best.fret) best = { fileString, fret };
      });
      if (!best) {
        this.warnings.add(
          `Some chords of “${plan.name}” have more notes than ${this.product} can hold: extra notes are left out.`,
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
    if (this.version < 4) {
      // Guitar Pro 3's diagram: a longer header, a 34-character name and six strings.
      out.u8(1).zeros(25);
      out.fixedString(chord.name ?? "", 34);
      out.i32(chord.firstFret ?? 1);
      for (let i = 0; i < 6; i++) out.i32(i < plan.tuning.length ? (chord.strings[i] ?? -1) : -1);
      out.zeros(36);
      return;
    }
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
    const { version } = this;
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
    // Guitar Pro 3 has one vibrato bit; later versions' vibrato is the second one.
    if (beat.vibrato !== VibratoType.None) flags |= version < 4 ? 0x01 : 0x02;
    if (beat.fade === FadeType.FadeIn) flags |= 0x10;
    if (slap) flags |= 0x20;
    if (brush) flags |= 0x40;
    if (version >= 4) {
      if (beat.rasgueado !== Rasgueado.None) flags2 |= 0x01;
      if (beat.pickStroke !== PickStroke.None) flags2 |= 0x02;
      if (whammy) flags2 |= 0x04;
    } else {
      // Guitar Pro 3 keeps harmonics on the beat, for all its notes.
      flags |= this.beatHarmonic(beat);
      if (beat.rasgueado !== Rasgueado.None || beat.pickStroke !== PickStroke.None || whammy) {
        this.warnings.add(
          `${this.product} has no rasgueado, pick strokes or whammy bar: they are left out.`,
        );
      }
    }
    if (flags === 0 && flags2 === 0) return null;
    return (out) => {
      out.u8(flags);
      if (version >= 4) out.u8(flags2);
      if (slap) {
        out.i8(slap);
        if (version < 4) out.i32(0); // the tremolo bar value Guitar Pro 3 keeps here
      }
      if (whammy && version >= 4) writeCurve(out, whammy);
      if (brush) {
        const value = strokeCode(beat.brushDuration);
        // Guitar Pro 5 stores the upstroke first, 3 and 4 the downstroke first.
        const up = brush === "up" ? value : 0;
        const down = brush === "down" ? value : 0;
        if (version >= 5) out.u8(up).u8(down);
        else out.u8(down).u8(up);
      }
      if (flags2 & 0x02) out.i8(beat.pickStroke === PickStroke.Up ? 1 : 2);
    };
  }

  /** The beat flag for Guitar Pro 3's harmonics: 4 natural, 8 artificial, 0 none. */
  private beatHarmonic(beat: Beat): number {
    const notes = beat.notes.filter((note) => note.isStringed);
    const types = new Set(notes.map((note) => note.harmonicType));
    if (types.size === 0 || (types.size === 1 && types.has(HarmonicType.None))) return 0;
    if (types.size === 1 && (types.has(HarmonicType.Natural) || types.has(HarmonicType.Feedback)))
      return 0x04;
    if (types.size === 1 && types.has(HarmonicType.Artificial)) return 0x08;
    this.warnings.add(
      `${this.product} keeps one natural or artificial harmonic for all the notes of a beat: other harmonics are left out.`,
    );
    return 0;
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
    const { version } = this;
    return (out) => {
      out.i8(instrument ? instrument.value : -1);
      if (version >= 5) out.zeros(16); // realistic sound engine bank
      out.i8(volume ? volume.value : -1);
      out.i8(balance ? balance.value : -1);
      out.i8(-1).i8(-1).i8(-1).i8(-1); // chorus, reverb, phaser, tremolo
      if (version >= 5) out.intByteString(tempo?.name ?? ""); // tempo name ("Allegro", "Breakdown"…)
      out.i32(tempo?.bpm ?? -1);
      if (volume) out.u8(0);
      if (balance) out.u8(0);
      if (tempo !== undefined) out.i8(0);
      if (version >= 4) out.u8(0); // applies to all tracks: no
      if (version >= 5) out.i8(-1); // wah pedal
    };
  }

  private writeNote(
    plan: TrackPlan,
    placed: PlacedNote,
    graceBeat: Beat | null,
    beat: Beat | null,
  ) {
    const { out, version } = this;
    const { note, fret } = placed;
    const effects = this.noteEffects(plan, placed, graceBeat, beat);
    const dynamic = note.dynamics !== DynamicValue.F;
    // Only Guitar Pro 5 keeps how long a note is held, as a share of its length.
    const fullDuration = note.durationPercent === 1;
    if (!fullDuration && version < 5) {
      this.warnings.add(`${this.product} holds every note for its full length.`);
    }
    const partial = !fullDuration && version >= 5;

    let flags = 0x20; // type and fret follow
    if (partial) flags |= 0x01;
    if (note.accentuated === AccentuationType.Heavy) flags |= 0x02;
    if (note.isGhost) flags |= 0x04;
    if (effects) flags |= 0x08;
    if (dynamic) flags |= 0x10;
    if (note.accentuated === AccentuationType.Normal) flags |= 0x40;
    out.u8(flags);
    out.u8(note.isTieDestination ? 2 : note.isDead ? 3 : 1);
    if (dynamic) out.i8(dynamicCode(note.dynamics));
    out.i8(fret);
    if (partial) out.f64BE(note.durationPercent);
    if (version >= 5) out.u8(0); // accidentals are not swapped
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
    const { version } = this;
    const bend = note.bendPoints && note.bendPoints.length > 0 ? note.bendPoints : null;
    const grace = graceBeat?.notes[0] ?? null;
    // Guitar Pro keeps tremolo picking with a note: the first one of the beat.
    const tremolo = beat?.tremoloPicking ?? null;
    const slide = this.slideCode(note);
    // Guitar Pro 3 keeps harmonics on the beat (see `beatHarmonic`).
    const harmonicCode = plan.kind === "stringed" && version >= 4 ? this.harmonicCode(note) : 0;
    const trill = plan.kind === "stringed" && note.isTrill;
    if (note.harmonicType === HarmonicType.Feedback) {
      this.warnings.add("Feedback harmonics are saved as natural harmonics.");
    }

    let flags = 0;
    let flags2 = 0;
    if (bend) flags |= 0x01;
    if (note.isHammerPullOrigin) flags |= 0x02;
    if (note.isLetRing) flags |= 0x08;
    if (grace) flags |= 0x10;
    if (version >= 4) {
      if (note.isStaccato) flags2 |= 0x01;
      if (note.isPalmMute) flags2 |= 0x02;
      if (tremolo) flags2 |= 0x04;
      if (slide) flags2 |= 0x08;
      if (harmonicCode) flags2 |= 0x10;
      if (trill) flags2 |= 0x20;
      if (note.vibrato !== VibratoType.None) flags2 |= 0x40;
    } else {
      // Guitar Pro 3's note effects: bend, hammer-on, slide, let ring and grace note.
      if (slide) flags |= 0x04;
      const lost = [
        [note.isStaccato, "staccato"],
        [note.isPalmMute, "palm mute"],
        [!!tremolo, "tremolo picking"],
        [trill, "trills"],
        [note.vibrato !== VibratoType.None, "vibrato on a note"],
      ] as const;
      for (const [present, name] of lost) {
        if (present) this.warnings.add(`${this.product} has no ${name}: it is left out.`);
      }
    }
    if (flags === 0 && flags2 === 0) return null;
    if (grace && graceBeat?.graceType === GraceType.OnBeat && version < 5) {
      this.warnings.add(`${this.product} plays grace notes before the beat, never on it.`);
    }

    return (out) => {
      out.u8(flags);
      if (version >= 4) out.u8(flags2);
      if (bend) writeCurve(out, bend);
      if (grace && graceBeat) {
        out.i8(grace.fret);
        out.i8(dynamicCode(graceBeat.dynamics));
        out.u8(graceTransition(grace));
        out.u8(1);
        if (version >= 5) {
          out.u8((grace.isDead ? 1 : 0) | (graceBeat.graceType === GraceType.OnBeat ? 2 : 0));
        }
      }
      if (version >= 4) {
        if (tremolo) out.u8(tremolo.marks);
        if (slide) out.i8(slide);
        if (harmonicCode) this.writeHarmonic(out, note, harmonicCode);
        if (trill) {
          out.u8(note.trillValue - note.stringTuning);
          out.u8(note.trillSpeed === 64 ? 3 : note.trillSpeed === 32 ? 2 : 1);
        }
      }
    };
  }

  /** The slide of a note as the generation stores it (0 for none). */
  private slideCode(note: Note): number {
    const out =
      note.slideOutType === SlideOutType.Shift
        ? 1
        : note.slideOutType === SlideOutType.Legato
          ? 2
          : note.slideOutType === SlideOutType.OutDown
            ? 3
            : note.slideOutType === SlideOutType.OutUp
              ? 4
              : 0;
    const into =
      note.slideInType === SlideInType.IntoFromBelow
        ? 1
        : note.slideInType === SlideInType.IntoFromAbove
          ? 2
          : 0;
    if (this.version >= 5) {
      // A set of bits: slide out 1, 2, 4, 8 and slide in 16, 32.
      return (out ? 1 << (out - 1) : 0) | (into ? 16 << (into - 1) : 0);
    }
    if (this.version === 4) {
      if (out && into) {
        this.warnings.add(
          `${this.product} has either a slide in or a slide out on a note, not both.`,
        );
      }
      return out || (into ? -into : 0);
    }
    // Guitar Pro 3 has one kind of slide: to the next note.
    if (into || out > 2) {
      this.warnings.add(
        `${this.product} has slides to the next note only: slides in and out of a note are left out.`,
      );
      return 0;
    }
    if (out === 2) {
      this.warnings.add(`${this.product} saves legato slides as shift slides.`);
    }
    return out ? 1 : 0;
  }

  /** The harmonic of a note as the generation stores it (0 for none). */
  private harmonicCode(note: Note): number {
    if (this.version >= 5) return harmonicTypeCode(note.harmonicType);
    // Guitar Pro 4 knows artificial harmonics as three fixed intervals.
    if (note.harmonicType !== HarmonicType.Artificial) return harmonicTypeCode(note.harmonicType);
    const delta = deltaFret(note.harmonicValue);
    const [interval, code] = [
      [5, 15],
      [7, 17],
      [12, 22],
    ].reduce((best, candidate) =>
      Math.abs(candidate[0]! - delta) < Math.abs(best[0]! - delta) ? candidate : best,
    );
    if (interval !== delta) {
      this.warnings.add(
        `${this.product} has artificial harmonics at 5, 7 and 12 frets only: others are saved at the nearest one.`,
      );
    }
    return code!;
  }

  private writeHarmonic(out: ByteWriter, note: Note, code: number) {
    out.u8(code);
    if (this.version < 5) return;
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

/** Writes `score` as a Guitar Pro 5 file (version 5.00). */
export const writeGp5 = (score: Score): GpResult => new GpWriter(score, 5).write();

/** Writes `score` as a Guitar Pro 4 file (version 4.06). */
export const writeGp4 = (score: Score): GpResult => new GpWriter(score, 4).write();

/** Writes `score` as a Guitar Pro 3 file (version 3.00). */
export const writeGp3 = (score: Score): GpResult => new GpWriter(score, 3).write();
