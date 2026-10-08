/**
 * The song's structure, bar by bar: time and key signatures, triplet feel,
 * tempo changes, sections, repeats, alternate endings and jumps (Segno, Coda,
 * D.C., D.S. ...). alphaTab keeps these on its master bars (and the key on
 * every track's bars); its player follows repeats, endings and jumps.
 *
 * These functions only change the model. The workspace runs them through
 * `ScoreEditor.run` (with {@link barSettingsTargets}) so they can be undone.
 */
import { model } from "@coderline/alphatab";

import { keyName, type KeySignature, type KeySignatureType } from "@/lib/score/keys";
import {
  isPlaceholderVoice,
  placeholderBeats,
  type MasterBar,
  type Score,
} from "@/lib/score/model";

const { Automation, AutomationType, Direction, Section, TripletFeel } = model;

export type TripletFeelType = model.TripletFeel;
export type DirectionType = model.Direction;

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export const MAX_NUMERATOR = 32;
export const DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;
/** How often a repeated part may be played. */
export const MAX_REPEAT_COUNT = 32;
/** alphaTab's limit for alternate endings (`MasterBar.MaxAlternateEndings`). */
export const MAX_ENDINGS = 8;
export const MIN_TEMPO = 10;
export const MAX_TEMPO = 400;
/** alphaTab's tempo when a song sets none. */
export const DEFAULT_TEMPO = 120;

export interface TempoMark {
  bpm: number;
  /** Shown with the tempo, e.g. "Allegro". */
  label: string;
}

/** Everything the bar dialog edits, as plain data. */
export interface BarSettings {
  timeSignature: TimeSignature;
  tripletFeel: TripletFeelType;
  keySignature: KeySignature;
  keyType: KeySignatureType;
  /** A tempo change at the start of the bar, or null (the tempo carries on). */
  tempo: TempoMark | null;
  /** Section name ("Chorus"), or "" for none. */
  section: string;
  repeatStart: boolean;
  /** Times the repeated part is played (2+), or 0 when no repeat ends here. */
  repeatEnd: number;
  /** Passes this bar is played on (bit 0 = 1st pass), or 0 for every pass. */
  endings: number;
  directions: DirectionType[];
}

export const TRIPLET_FEELS: { value: TripletFeelType; label: string }[] = [
  { value: TripletFeel.NoTripletFeel, label: "None" },
  { value: TripletFeel.Triplet8th, label: "Triplet 8th" },
  { value: TripletFeel.Triplet16th, label: "Triplet 16th" },
  { value: TripletFeel.Dotted8th, label: "Dotted 8th" },
  { value: TripletFeel.Dotted16th, label: "Dotted 16th" },
  { value: TripletFeel.Scottish8th, label: "Scottish 8th" },
  { value: TripletFeel.Scottish16th, label: "Scottish 16th" },
];

export interface DirectionInfo {
  value: DirectionType;
  /** As printed in the score. */
  label: string;
  /** For screen readers. */
  spoken: string;
  /** Where a jump can go ("target"), or a jump itself. */
  kind: "target" | "jump";
}

/** Every jump and jump target Guitar Pro 5 has. */
export const DIRECTIONS: DirectionInfo[] = [
  { value: Direction.TargetSegno, label: "Segno", spoken: "Segno", kind: "target" },
  {
    value: Direction.TargetSegnoSegno,
    label: "Segno Segno",
    spoken: "Segno Segno",
    kind: "target",
  },
  { value: Direction.TargetCoda, label: "Coda", spoken: "Coda", kind: "target" },
  {
    value: Direction.TargetDoubleCoda,
    label: "Double Coda",
    spoken: "Double Coda",
    kind: "target",
  },
  { value: Direction.TargetFine, label: "Fine", spoken: "Fine", kind: "target" },
  { value: Direction.JumpDaCapo, label: "D.C.", spoken: "Da Capo", kind: "jump" },
  {
    value: Direction.JumpDaCapoAlCoda,
    label: "D.C. al Coda",
    spoken: "Da Capo al Coda",
    kind: "jump",
  },
  {
    value: Direction.JumpDaCapoAlDoubleCoda,
    label: "D.C. al Double Coda",
    spoken: "Da Capo al Double Coda",
    kind: "jump",
  },
  {
    value: Direction.JumpDaCapoAlFine,
    label: "D.C. al Fine",
    spoken: "Da Capo al Fine",
    kind: "jump",
  },
  { value: Direction.JumpDalSegno, label: "D.S.", spoken: "Dal Segno", kind: "jump" },
  {
    value: Direction.JumpDalSegnoAlCoda,
    label: "D.S. al Coda",
    spoken: "Dal Segno al Coda",
    kind: "jump",
  },
  {
    value: Direction.JumpDalSegnoAlDoubleCoda,
    label: "D.S. al Double Coda",
    spoken: "Dal Segno al Double Coda",
    kind: "jump",
  },
  {
    value: Direction.JumpDalSegnoAlFine,
    label: "D.S. al Fine",
    spoken: "Dal Segno al Fine",
    kind: "jump",
  },
  { value: Direction.JumpDalSegnoSegno, label: "D.S.S.", spoken: "Dal Segno Segno", kind: "jump" },
  {
    value: Direction.JumpDalSegnoSegnoAlCoda,
    label: "D.S.S. al Coda",
    spoken: "Dal Segno Segno al Coda",
    kind: "jump",
  },
  {
    value: Direction.JumpDalSegnoSegnoAlDoubleCoda,
    label: "D.S.S. al Double Coda",
    spoken: "Dal Segno Segno al Double Coda",
    kind: "jump",
  },
  {
    value: Direction.JumpDalSegnoSegnoAlFine,
    label: "D.S.S. al Fine",
    spoken: "Dal Segno Segno al Fine",
    kind: "jump",
  },
  { value: Direction.JumpDaCoda, label: "To Coda", spoken: "To Coda", kind: "jump" },
  {
    value: Direction.JumpDaDoubleCoda,
    label: "To Double Coda",
    spoken: "To Double Coda",
    kind: "jump",
  },
];

export const directionInfo = (value: DirectionType) => DIRECTIONS.find((d) => d.value === value)!;

const keyBar = (score: Score, index: number) => score.tracks[0]?.staves[0]?.bars[index] ?? null;

/** The tempo change at the very start of a master bar, if any. */
const startTempo = (masterBar: MasterBar) =>
  masterBar.tempoAutomations.find(
    (a) => a.type === AutomationType.Tempo && a.ratioPosition === 0,
  ) ?? null;

/** The tempo in effect at the start of a bar (after all earlier changes). */
export function tempoAt(score: Score, index: number): number {
  for (let i = Math.min(index, score.masterBars.length - 1); i >= 0; i--) {
    const changes = score.masterBars[i]!.tempoAutomations.filter(
      (a) => a.type === AutomationType.Tempo && (i < index || a.ratioPosition === 0),
    ).sort((a, b) => a.ratioPosition - b.ratioPosition);
    if (changes.length > 0) return changes.at(-1)!.value;
  }
  return DEFAULT_TEMPO;
}

/** A named part of the song (Verse, Chorus…), from its section marker to the next one. */
export interface SongSection {
  name: string;
  /** First and last bar, 0-based and inclusive. */
  start: number;
  end: number;
  /** For lists: "Verse · bars 5–12", so parts with the same name stay apart. */
  label: string;
}

/**
 * The song's sections (#83): every bar with a section marker starts one, which lasts until the
 * next marker or the end. Empty when the score has no usable markers (then bars are used).
 */
export function sectionsOf(score: Score): SongSection[] {
  const starts = score.masterBars.flatMap((bar, index) => {
    const name = (bar.section?.text || bar.section?.marker || "").trim();
    return name ? [{ name, start: index }] : [];
  });
  return starts.map(({ name, start }, i) => {
    const end = (starts[i + 1]?.start ?? score.masterBars.length) - 1;
    const bars = start === end ? `bar ${start + 1}` : `bars ${start + 1}–${end + 1}`;
    return { name, start, end, label: `${name} · ${bars}` };
  });
}

/** The section a bar is in, or null. */
export const sectionAt = (sections: readonly SongSection[], bar: number) =>
  sections.find((s) => bar >= s.start && bar <= s.end) ?? null;

export function barSettingsOf(score: Score, index: number): BarSettings {
  const masterBar = score.masterBars[index]!;
  const bar = keyBar(score, index);
  const tempo = startTempo(masterBar);
  return {
    timeSignature: {
      numerator: masterBar.timeSignatureNumerator,
      denominator: masterBar.timeSignatureDenominator,
    },
    tripletFeel: masterBar.tripletFeel,
    keySignature: bar?.keySignature ?? 0,
    keyType: bar?.keySignatureType ?? 0,
    tempo: tempo ? { bpm: tempo.value, label: tempo.text } : null,
    section: masterBar.section?.text ?? "",
    repeatStart: masterBar.isRepeatStart,
    repeatEnd: masterBar.repeatCount > 0 ? masterBar.repeatCount : 0,
    endings: masterBar.alternateEndings,
    directions: [...(masterBar.directions ?? [])].sort((a, b) => a - b),
  };
}

const sameTime = (a: TimeSignature, b: TimeSignature) =>
  a.numerator === b.numerator && a.denominator === b.denominator;

/** Changes that carry on to the following bars (until the next change). */
function carriesOn(before: BarSettings, next: BarSettings) {
  return (
    !sameTime(before.timeSignature, next.timeSignature) ||
    before.tripletFeel !== next.tripletFeel ||
    before.keySignature !== next.keySignature ||
    before.keyType !== next.keyType
  );
}

/** What an edit from `before` to `next` changes, e.g. ["time signature", "tempo"]. */
export function changedParts(before: BarSettings, next: BarSettings): string[] {
  const parts: string[] = [];
  if (!sameTime(before.timeSignature, next.timeSignature)) parts.push("time signature");
  if (before.keySignature !== next.keySignature || before.keyType !== next.keyType)
    parts.push("key signature");
  if (before.tripletFeel !== next.tripletFeel) parts.push("triplet feel");
  if (JSON.stringify(before.tempo) !== JSON.stringify(next.tempo)) parts.push("tempo");
  if (before.section !== next.section) parts.push("section");
  if (before.repeatStart !== next.repeatStart || before.repeatEnd !== next.repeatEnd)
    parts.push("repeat");
  if (before.endings !== next.endings) parts.push("alternate ending");
  if (before.directions.join() !== next.directions.join()) parts.push("jump");
  return parts;
}

/**
 * The bars {@link applyBarSettings} can change: just this one, or (when a
 * time or key signature or the triplet feel changes) every bar from it to the
 * end. Work it out before the edit: undo records these bars before and after.
 */
export function barSettingsRange(
  score: Score,
  index: number,
  next: BarSettings,
): { from: number; to: number } {
  const before = barSettingsOf(score, index);
  return { from: index, to: carriesOn(before, next) ? score.masterBars.length - 1 : index };
}

/**
 * Writes `value` at bar `index` and on the following bars that had the same
 * old value, so a change lasts until the song's next change, as in Guitar Pro.
 */
function carryForward<T>(
  count: number,
  index: number,
  read: (i: number) => T,
  write: (i: number, value: T) => void,
  value: T,
  same: (a: T, b: T) => boolean,
) {
  const old = read(index);
  if (same(old, value)) return;
  for (let i = index; i < count && (i === index || same(read(i), old)); i++) write(i, value);
}

/** Bars holding nothing but rests get rests that fit their (new) time signature. */
function refillRests(score: Score, index: number) {
  const masterBar = score.masterBars[index]!;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const bar = staff.bars[index];
      for (const voice of bar?.voices ?? []) {
        if (!isPlaceholderVoice(voice)) continue;
        voice.beats.splice(0);
        for (const beat of placeholderBeats(masterBar, voice.index)) voice.addBeat(beat);
      }
    }
  }
}

function tempoAutomation(tempo: TempoMark) {
  const automation = Automation.buildTempoAutomation(false, 0, tempo.bpm, 2);
  automation.text = tempo.label.trim();
  return automation;
}

/**
 * Applies the bar dialog's settings to bar `index`. Time and key signatures
 * and triplet feel carry on until the next bar that changes them; bars that
 * only hold rests get new rests, written music is never moved (as in Guitar
 * Pro, bars may then be too full or not full enough).
 */
export function applyBarSettings(score: Score, index: number, next: BarSettings): void {
  const masterBar = score.masterBars[index];
  if (!masterBar) return;
  const count = score.masterBars.length;
  const bars = score.masterBars;

  carryForward(
    count,
    index,
    (i) => ({
      numerator: bars[i]!.timeSignatureNumerator,
      denominator: bars[i]!.timeSignatureDenominator,
    }),
    (i, time) => {
      bars[i]!.timeSignatureNumerator = time.numerator;
      bars[i]!.timeSignatureDenominator = time.denominator;
      bars[i]!.timeSignatureCommon = false;
      refillRests(score, i);
    },
    next.timeSignature,
    sameTime,
  );
  carryForward(
    count,
    index,
    (i) => bars[i]!.tripletFeel,
    (i, feel) => {
      bars[i]!.tripletFeel = feel;
    },
    next.tripletFeel,
    (a, b) => a === b,
  );
  carryForward(
    count,
    index,
    (i) => ({
      signature: keyBar(score, i)?.keySignature ?? 0,
      type: keyBar(score, i)?.keySignatureType ?? 0,
    }),
    (i, key) => {
      for (const track of score.tracks) {
        for (const staff of track.staves) {
          const bar = staff.bars[i];
          if (!bar) continue;
          bar.keySignature = key.signature;
          bar.keySignatureType = key.type;
        }
      }
    },
    { signature: next.keySignature, type: next.keyType },
    (a, b) => a.signature === b.signature && a.type === b.type,
  );

  // The first bar always keeps a tempo: it is the song's tempo.
  const tempo = next.tempo ?? (index === 0 ? barSettingsOf(score, 0).tempo : null);
  const current = startTempo(masterBar);
  if (
    JSON.stringify(current ? { bpm: current.value, label: current.text } : null) !==
    JSON.stringify(tempo)
  ) {
    const later = masterBar.tempoAutomations.filter((a) => a !== current);
    masterBar.tempoAutomations = tempo ? [tempoAutomation(tempo), ...later] : later;
  }

  const name = next.section.trim();
  if (name !== (masterBar.section?.text ?? "")) {
    masterBar.section = name
      ? Object.assign(new Section(), { marker: masterBar.section?.marker ?? "", text: name })
      : null;
  }
  masterBar.isRepeatStart = next.repeatStart;
  masterBar.repeatCount = next.repeatEnd >= 2 ? Math.min(MAX_REPEAT_COUNT, next.repeatEnd) : 0;
  masterBar.alternateEndings = next.endings & ((1 << MAX_ENDINGS) - 1);
  masterBar.directions = next.directions.length > 0 ? new Set(next.directions) : null;
}

/** Turns the repeat start sign of a bar on or off. */
export function toggleRepeatStart(score: Score, index: number): void {
  const masterBar = score.masterBars[index];
  if (masterBar) masterBar.isRepeatStart = !masterBar.isRepeatStart;
}

/** Turns the repeat end sign of a bar on (played twice) or off. */
export function toggleRepeatEnd(score: Score, index: number): void {
  const masterBar = score.masterBars[index];
  if (masterBar) masterBar.repeatCount = masterBar.repeatCount > 0 ? 0 : 2;
}

const DA_CAPO = [
  Direction.JumpDaCapo,
  Direction.JumpDaCapoAlCoda,
  Direction.JumpDaCapoAlDoubleCoda,
  Direction.JumpDaCapoAlFine,
];
const JUMPS_TO_SEGNO = [
  Direction.JumpDalSegno,
  Direction.JumpDalSegnoAlCoda,
  Direction.JumpDalSegnoAlDoubleCoda,
  Direction.JumpDalSegnoAlFine,
];
const JUMPS_TO_SEGNO_SEGNO = [
  Direction.JumpDalSegnoSegno,
  Direction.JumpDalSegnoSegnoAlCoda,
  Direction.JumpDalSegnoSegnoAlDoubleCoda,
  Direction.JumpDalSegnoSegnoAlFine,
];
const AL_CODA = [
  Direction.JumpDaCapoAlCoda,
  Direction.JumpDalSegnoAlCoda,
  Direction.JumpDalSegnoSegnoAlCoda,
];
const AL_DOUBLE_CODA = [
  Direction.JumpDaCapoAlDoubleCoda,
  Direction.JumpDalSegnoAlDoubleCoda,
  Direction.JumpDalSegnoSegnoAlDoubleCoda,
];
const AL_FINE = [
  Direction.JumpDaCapoAlFine,
  Direction.JumpDalSegnoAlFine,
  Direction.JumpDalSegnoSegnoAlFine,
];

type Draft = { index: number; settings: Pick<BarSettings, "directions" | "endings"> };

/**
 * Whether a D.C. or D.S. jump goes back over bars with alternate endings.
 * alphaTab plays every ending bar after a jump (repeats are not played
 * again), so such a song doesn't sound as written.
 */
function replaysEndings(score: Score, draft?: Draft): boolean {
  const bars = score.masterBars.map((masterBar, index) => {
    const edited = draft?.index === index ? draft.settings : null;
    return {
      directions: new Set(edited ? edited.directions : (masterBar.directions ?? [])),
      endings: edited ? edited.endings : masterBar.alternateEndings,
    };
  });
  // Where a jump from bar `from` lands: alphaTab looks backwards first.
  const target = (sign: DirectionType, from: number) => {
    for (let i = from; i >= 0; i--) if (bars[i]!.directions.has(sign)) return i;
    return bars.findIndex((bar) => bar.directions.has(sign));
  };
  return bars.some((bar, index) => {
    const landsAt = [...bar.directions].flatMap((direction) => {
      if (DA_CAPO.includes(direction)) return [0];
      if (JUMPS_TO_SEGNO.includes(direction)) return [target(Direction.TargetSegno, index)];
      if (JUMPS_TO_SEGNO_SEGNO.includes(direction))
        return [target(Direction.TargetSegnoSegno, index)];
      return [];
    });
    return landsAt.some(
      (start) => start >= 0 && bars.slice(start, index + 1).some((b) => b.endings !== 0),
    );
  });
}

/**
 * Problems with the song's jumps that make playback differ from what the
 * score says, e.g. a D.S. without a Segno to jump to. With `draft`, bar
 * `draft.index` is judged with the jumps and endings being edited.
 */
export function structureWarnings(score: Score, draft?: Draft): string[] {
  const used = new Set<DirectionType>();
  score.masterBars.forEach((masterBar, index) => {
    const edited = draft?.index === index ? draft.settings : null;
    for (const direction of edited ? edited.directions : (masterBar.directions ?? [])) {
      used.add(direction);
    }
  });
  const uses = (list: DirectionType[]) => list.some((d) => used.has(d));
  const warnings: string[] = [];
  if (uses(JUMPS_TO_SEGNO) && !used.has(Direction.TargetSegno))
    warnings.push("A D.S. jump has no Segno to go back to.");
  if (uses(JUMPS_TO_SEGNO_SEGNO) && !used.has(Direction.TargetSegnoSegno))
    warnings.push("A D.S.S. jump has no Segno Segno to go back to.");
  if (uses(AL_CODA) && !(used.has(Direction.JumpDaCoda) && used.has(Direction.TargetCoda)))
    warnings.push("An “al Coda” jump needs a “To Coda” sign and a Coda.");
  if (
    uses(AL_DOUBLE_CODA) &&
    !(used.has(Direction.JumpDaDoubleCoda) && used.has(Direction.TargetDoubleCoda))
  )
    warnings.push("An “al Double Coda” jump needs a “To Double Coda” sign and a Double Coda.");
  if (uses(AL_FINE) && !used.has(Direction.TargetFine))
    warnings.push("An “al Fine” jump needs a Fine to stop at.");
  if (replaysEndings(score, draft)) {
    warnings.push(
      "After a D.C. or D.S. jump, playback plays every alternate ending (repeats are not played again).",
    );
  }
  return warnings;
}

/** "3/4", "Triplet 8th"... for messages. */
export const timeSignatureText = ({ numerator, denominator }: TimeSignature) =>
  `${numerator}/${denominator}`;

/** A short spoken summary of a bar's structure, e.g. "4/4, G major, Chorus, repeat start". */
export function describeBar(score: Score, index: number): string {
  const s = barSettingsOf(score, index);
  const parts = [timeSignatureText(s.timeSignature), keyName(s.keySignature, s.keyType)];
  if (s.tempo) parts.push(`${s.tempo.bpm} BPM`);
  if (s.section) parts.push(s.section);
  if (s.repeatStart) parts.push("repeat start");
  if (s.repeatEnd) parts.push(`repeat end, ${s.repeatEnd} times`);
  for (const d of s.directions) parts.push(directionInfo(d).label);
  return parts.join(", ");
}
