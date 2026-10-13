/**
 * Music vocabulary shared by the editor, the track settings and the
 * instrument views: pitch names, note values, tuplets, General MIDI
 * instruments, tunings and the drum kit. Plain data, no alphaTab objects.
 */
import { model } from "@coderline/alphatab";

const { Duration } = model;
export type Duration = model.Duration;

/** Sharps, as Guitar Pro spells them. Index = pitch class (0 = C). */
export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

/** Spoken note names ("C sharp"), since screen readers read "#" as "number". */
const SPOKEN_NOTE_NAMES = NOTE_NAMES.map((name) => name.replace("#", " sharp"));

/** Scientific pitch notation: MIDI 60 = C4, 40 = E2 (a guitar's low E). */
export function pitchName(midi: number, { octave = true, spoken = false } = {}): string {
  const names = spoken ? SPOKEN_NOTE_NAMES : NOTE_NAMES;
  const name = names[((midi % 12) + 12) % 12]!;
  return octave ? `${name}${Math.floor(midi / 12) - 1}` : name;
}

/** MIDI pitch of a letter name (A–G) in the octave closest to `near`. */
export function pitchFromLetter(letter: string, near: number): number | null {
  const pitchClass = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter.toUpperCase()];
  if (pitchClass === undefined) return null;
  let best = pitchClass;
  for (let octave = 0; octave <= 10; octave++) {
    const candidate = octave * 12 + pitchClass;
    if (Math.abs(candidate - near) < Math.abs(best - near)) best = candidate;
  }
  return best;
}

export interface NoteValue {
  duration: Duration;
  /** Toolbar label, e.g. "Quarter". */
  label: string;
}

/** Note values the editor offers, longest first. */
export const NOTE_VALUES: NoteValue[] = [
  { duration: Duration.Whole, label: "Whole" },
  { duration: Duration.Half, label: "Half" },
  { duration: Duration.Quarter, label: "Quarter" },
  { duration: Duration.Eighth, label: "Eighth" },
  { duration: Duration.Sixteenth, label: "16th" },
  { duration: Duration.ThirtySecond, label: "32nd" },
  { duration: Duration.SixtyFourth, label: "64th" },
];

export const noteValueLabel = (duration: Duration) =>
  NOTE_VALUES.find((v) => v.duration === duration)?.label ?? `1/${duration}`;

/** The next shorter (`step` 1) or longer (`step` -1) note value, clamped. */
export function stepDuration(duration: Duration, step: 1 | -1): Duration {
  const index = NOTE_VALUES.findIndex((v) => v.duration === duration);
  const next = Math.min(NOTE_VALUES.length - 1, Math.max(0, (index < 0 ? 2 : index) + step));
  return NOTE_VALUES[next]!.duration;
}

/** Ticks per quarter note, as in alphaTab's MIDI. */
export const QUARTER_TICKS = 960;

/** Length of a note value in ticks, with dots and a tuplet ratio. */
export function durationTicks(duration: Duration, dots = 0, tuplet: Tuplet = NO_TUPLET): number {
  const base = (QUARTER_TICKS * 4) / duration;
  let ticks = base;
  let add = base;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    ticks += add;
  }
  return (ticks * tuplet.denominator) / tuplet.numerator;
}

export interface Tuplet {
  /** Notes played... */
  numerator: number;
  /** ...in the time of. */
  denominator: number;
}

export const NO_TUPLET: Tuplet = { numerator: 1, denominator: 1 };

/** Tuplets Guitar Pro offers. */
export const TUPLETS: (Tuplet & { label: string })[] = [
  { ...NO_TUPLET, label: "None" },
  { numerator: 3, denominator: 2, label: "Triplet (3:2)" },
  { numerator: 5, denominator: 4, label: "Quintuplet (5:4)" },
  { numerator: 6, denominator: 4, label: "Sextuplet (6:4)" },
  { numerator: 7, denominator: 4, label: "Septuplet (7:4)" },
  { numerator: 9, denominator: 8, label: "9:8" },
  { numerator: 10, denominator: 8, label: "10:8" },
  { numerator: 11, denominator: 8, label: "11:8" },
  { numerator: 12, denominator: 8, label: "12:8" },
  { numerator: 13, denominator: 8, label: "13:8" },
];

export const tupletKey = ({ numerator, denominator }: Tuplet) => `${numerator}:${denominator}`;

/** Most notes a tuplet (nested ones included) may hold. */
export const MAX_TUPLET_NOTES = 64;

/**
 * A tuplet inside a tuplet as the one flat ratio alphaTab stores: the ratios
 * multiply. A triplet of triplets is 9 notes in the time of 4 (3:2 × 3:2), a
 * quintuplet inside a triplet 15 in the time of 8. Timing and playback follow
 * the flat ratio; the score draws one bracket for the whole group.
 */
export function composeTuplet(outer: Tuplet, inner: Tuplet): Tuplet {
  return {
    numerator: outer.numerator * inner.numerator,
    denominator: outer.denominator * inner.denominator,
  };
}

/** Whether a ratio is a real tuplet: more notes than the time it takes, within limits. */
export const isTuplet = ({ numerator, denominator }: Tuplet) =>
  Number.isInteger(numerator) &&
  Number.isInteger(denominator) &&
  denominator >= 1 &&
  numerator > denominator &&
  numerator <= MAX_TUPLET_NOTES;

/** "Triplet (3:2)", or just "9:4" for a ratio the list does not name. */
export const tupletLabel = (tuplet: Tuplet) =>
  TUPLETS.find((t) => tupletKey(t) === tupletKey(tuplet))?.label ?? tupletKey(tuplet);

/**
 * Rests that fill a bar of the given time signature: one rest when a single
 * (dotted) note value fits exactly, e.g. a whole rest in 4/4 or a dotted half
 * in 3/4, otherwise one rest per beat, e.g. five quarters in 5/4.
 */
export function barRests(
  numerator: number,
  denominator: number,
): { duration: Duration; dots: number }[] {
  const barTicks = (QUARTER_TICKS * 4 * numerator) / denominator;
  for (const { duration } of NOTE_VALUES) {
    for (const dots of [0, 1]) {
      if (durationTicks(duration, dots) === barTicks) return [{ duration, dots }];
    }
  }
  const beat = NOTE_VALUES.find((v) => v.duration === denominator)?.duration ?? Duration.Quarter;
  return Array.from({ length: numerator }, () => ({ duration: beat, dots: 0 }));
}

/** General MIDI program names (0–127), grouped in families of eight. */
export const GM_INSTRUMENTS = [
  "Acoustic Grand Piano",
  "Bright Acoustic Piano",
  "Electric Grand Piano",
  "Honky-tonk Piano",
  "Electric Piano 1",
  "Electric Piano 2",
  "Harpsichord",
  "Clavinet",
  "Celesta",
  "Glockenspiel",
  "Music Box",
  "Vibraphone",
  "Marimba",
  "Xylophone",
  "Tubular Bells",
  "Dulcimer",
  "Drawbar Organ",
  "Percussive Organ",
  "Rock Organ",
  "Church Organ",
  "Reed Organ",
  "Accordion",
  "Harmonica",
  "Tango Accordion",
  "Acoustic Guitar (nylon)",
  "Acoustic Guitar (steel)",
  "Electric Guitar (jazz)",
  "Electric Guitar (clean)",
  "Electric Guitar (muted)",
  "Overdriven Guitar",
  "Distortion Guitar",
  "Guitar Harmonics",
  "Acoustic Bass",
  "Electric Bass (finger)",
  "Electric Bass (pick)",
  "Fretless Bass",
  "Slap Bass 1",
  "Slap Bass 2",
  "Synth Bass 1",
  "Synth Bass 2",
  "Violin",
  "Viola",
  "Cello",
  "Contrabass",
  "Tremolo Strings",
  "Pizzicato Strings",
  "Orchestral Harp",
  "Timpani",
  "String Ensemble 1",
  "String Ensemble 2",
  "Synth Strings 1",
  "Synth Strings 2",
  "Choir Aahs",
  "Voice Oohs",
  "Synth Voice",
  "Orchestra Hit",
  "Trumpet",
  "Trombone",
  "Tuba",
  "Muted Trumpet",
  "French Horn",
  "Brass Section",
  "Synth Brass 1",
  "Synth Brass 2",
  "Soprano Sax",
  "Alto Sax",
  "Tenor Sax",
  "Baritone Sax",
  "Oboe",
  "English Horn",
  "Bassoon",
  "Clarinet",
  "Piccolo",
  "Flute",
  "Recorder",
  "Pan Flute",
  "Blown Bottle",
  "Shakuhachi",
  "Whistle",
  "Ocarina",
  "Lead 1 (square)",
  "Lead 2 (sawtooth)",
  "Lead 3 (calliope)",
  "Lead 4 (chiff)",
  "Lead 5 (charang)",
  "Lead 6 (voice)",
  "Lead 7 (fifths)",
  "Lead 8 (bass + lead)",
  "Pad 1 (new age)",
  "Pad 2 (warm)",
  "Pad 3 (polysynth)",
  "Pad 4 (choir)",
  "Pad 5 (bowed)",
  "Pad 6 (metallic)",
  "Pad 7 (halo)",
  "Pad 8 (sweep)",
  "FX 1 (rain)",
  "FX 2 (soundtrack)",
  "FX 3 (crystal)",
  "FX 4 (atmosphere)",
  "FX 5 (brightness)",
  "FX 6 (goblins)",
  "FX 7 (echoes)",
  "FX 8 (sci-fi)",
  "Sitar",
  "Banjo",
  "Shamisen",
  "Koto",
  "Kalimba",
  "Bagpipe",
  "Fiddle",
  "Shanai",
  "Tinkle Bell",
  "Agogo",
  "Steel Drums",
  "Woodblock",
  "Taiko Drum",
  "Melodic Tom",
  "Synth Drum",
  "Reverse Cymbal",
  "Guitar Fret Noise",
  "Breath Noise",
  "Seashore",
  "Bird Tweet",
  "Telephone Ring",
  "Helicopter",
  "Applause",
  "Gunshot",
] as const;

export const GM_FAMILIES = [
  "Piano",
  "Chromatic percussion",
  "Organ",
  "Guitar",
  "Bass",
  "Strings",
  "Ensemble",
  "Brass",
  "Reed",
  "Pipe",
  "Synth lead",
  "Synth pad",
  "Synth effects",
  "Ethnic",
  "Percussive",
  "Sound effects",
] as const;

export const instrumentName = (program: number): string =>
  GM_INSTRUMENTS[program] ?? `Program ${program + 1}`;

/** What a track holds: tab with a tuning, pitched notes on a staff, or drum sounds. */
export type TrackKind = "stringed" | "pitched" | "drums";

export interface InstrumentPreset {
  id: string;
  /** Shown in the Add track dialog. */
  label: string;
  /** Default track name. */
  name: string;
  kind: TrackKind;
  program: number;
  /** MIDI pitches, highest string first (alphaTab's order). */
  tuning?: number[];
}

export const STANDARD_GUITAR = [64, 59, 55, 50, 45, 40];

/** Instruments offered when adding a track. "Other" tracks take any GM program. */
export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  {
    id: "guitar",
    label: "Guitar (6 strings)",
    name: "Guitar",
    kind: "stringed",
    program: 25,
    tuning: STANDARD_GUITAR,
  },
  {
    id: "electric-guitar",
    label: "Electric guitar (6 strings)",
    name: "Electric Guitar",
    kind: "stringed",
    program: 29,
    tuning: STANDARD_GUITAR,
  },
  {
    id: "classical-guitar",
    label: "Classical guitar (6 strings)",
    name: "Classical Guitar",
    kind: "stringed",
    program: 24,
    tuning: STANDARD_GUITAR,
  },
  {
    id: "guitar-7",
    label: "Guitar (7 strings)",
    name: "7-String Guitar",
    kind: "stringed",
    program: 30,
    tuning: [...STANDARD_GUITAR, 35],
  },
  {
    id: "guitar-8",
    label: "Guitar (8 strings)",
    name: "8-String Guitar",
    kind: "stringed",
    program: 30,
    tuning: [...STANDARD_GUITAR, 35, 30],
  },
  {
    id: "guitar-9",
    label: "Guitar (9 strings)",
    name: "9-String Guitar",
    kind: "stringed",
    program: 30,
    tuning: [...STANDARD_GUITAR, 35, 30, 25],
  },
  {
    id: "bass-4",
    label: "Bass (4 strings)",
    name: "Bass",
    kind: "stringed",
    program: 33,
    tuning: [43, 38, 33, 28],
  },
  {
    id: "bass-5",
    label: "Bass (5 strings)",
    name: "5-String Bass",
    kind: "stringed",
    program: 33,
    tuning: [43, 38, 33, 28, 23],
  },
  {
    id: "bass-6",
    label: "Bass (6 strings)",
    name: "6-String Bass",
    kind: "stringed",
    program: 33,
    tuning: [48, 43, 38, 33, 28, 23],
  },
  {
    id: "banjo",
    label: "Banjo (5 strings)",
    name: "Banjo",
    kind: "stringed",
    program: 105,
    tuning: [62, 59, 55, 50, 67],
  },
  {
    id: "ukulele",
    label: "Ukulele (4 strings)",
    name: "Ukulele",
    kind: "stringed",
    program: 24,
    tuning: [69, 64, 60, 67],
  },
  { id: "drums", label: "Drums", name: "Drums", kind: "drums", program: 0 },
  { id: "piano", label: "Piano", name: "Piano", kind: "pitched", program: 0 },
  {
    id: "other",
    label: "Other instrument (General MIDI)",
    name: "Instrument",
    kind: "pitched",
    program: 48,
  },
];

export const getPreset = (id: string) => INSTRUMENT_PRESETS.find((p) => p.id === id);

/** String counts the track settings allow (Guitar Pro 8 offers 3 to 10). */
export const MIN_STRINGS = 3;
export const MAX_STRINGS = 10;
export const MAX_CAPO = 24;
/** Highest fret the editor accepts (Guitar Pro allows 0–29). */
export const MAX_FRET = 29;

export interface TuningPreset {
  name: string;
  tuning: number[];
}

/** Open strings, highest first, of an extended-range guitar in standard tuning (E, B, G, D, A, E, then fourths). */
const STANDARD_STRINGS = [64, 59, 55, 50, 45, 40, 35, 30, 25, 20];

/** The same tuning `semitones` lower. */
export const transposeTuning = (tuning: readonly number[], semitones: number): number[] =>
  tuning.map((pitch) => Math.min(127, Math.max(0, pitch + semitones)));

/** The tuning with its lowest string a whole step lower ("drop" tunings). */
const dropped = (tuning: readonly number[]): number[] =>
  tuning.map((pitch, i) => (i === tuning.length - 1 ? Math.max(0, pitch - 2) : pitch));

/** The lowest sounding pitch of a tuning (the lowest open string plus the capo). */
export const lowestPitch = (tuning: readonly number[], capo = 0): number =>
  tuning.length === 0 ? 0 : Math.min(...tuning) + capo;

/**
 * Tunings for heavy and extended-range guitars (djent, deathcore, metalcore):
 * the standard tuning of the string count, tuned down in steps, and the same
 * with the lowest string dropped a whole step. Named after the lowest string:
 * "B standard" on a seven string, "Drop A" the same with that string on A.
 */
function heavyTunings(strings: number): TuningPreset[] {
  const base = STANDARD_STRINGS.slice(0, strings);
  const note = (pitch: number) => pitchName(pitch, { octave: false });
  const standards: [number, string?][] = [[0], [1], [2]];
  if (strings === 6) standards.push([4, "C standard"]);
  const out: TuningPreset[] = standards.map(([down, name]) => {
    const tuning = transposeTuning(base, -down);
    return { name: name ?? `${note(lowestPitch(tuning))} standard`, tuning };
  });
  // A six string is "Drop D" when the low E drops; the others follow in half steps.
  const drops = strings === 6 ? [0, 1, 2, 3, 4, 5] : [0, 1, 2];
  for (const down of drops) {
    const tuning = dropped(transposeTuning(base, -down));
    out.push({ name: `Drop ${note(lowestPitch(tuning))}`, tuning });
  }
  return out;
}

/** Tunings for 3-string instruments, which alphaTab lacks. */
const EXTRA_TUNINGS: Record<number, TuningPreset[]> = {
  3: [{ name: "Cigar box open G", tuning: [55, 50, 43] }],
};

const sameTuning = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((pitch, i) => pitch === b[i]);

/**
 * Known tunings for a string count: alphaTab's (standard first, then the
 * drop, open and other tunings), then ours for heavy and extended-range
 * guitars of 6 to 10 strings that alphaTab does not name, then the extra ones
 * for other instruments. A tuning both know keeps alphaTab's name.
 */
export function tuningPresets(stringCount: number): TuningPreset[] {
  const known = model.Tuning.getPresetsFor(stringCount).map((t) => ({
    name: t.name,
    tuning: [...t.tunings],
  }));
  const ours = (stringCount >= 6 && stringCount <= 10 ? heavyTunings(stringCount) : []).filter(
    (o) => !known.some((t) => sameTuning(o.tuning, t.tuning)),
  );
  return [...known, ...ours, ...(EXTRA_TUNINGS[stringCount] ?? [])];
}

/** The name of a known tuning, or null for a custom one. */
export function tuningName(tuning: readonly number[]): string | null {
  return (
    tuningPresets(tuning.length).find(
      (preset) =>
        preset.tuning.length === tuning.length && preset.tuning.every((p, i) => p === tuning[i]),
    )?.name ?? null
  );
}

/** Basses are tuned in fourths: E A D G, B E A D G, B E A D G C. */
const STANDARD_BASS: Record<number, number[]> = {
  4: [43, 38, 33, 28],
  5: [43, 38, 33, 28, 23],
  6: [48, 43, 38, 33, 28, 23],
};

/** The steps between strings, lowest last (alphaTab's order). */
const intervals = (tuning: readonly number[]) => tuning.slice(1).map((p, i) => tuning[i]! - p);
const sameSteps = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && intervals(a).every((step, i) => step === intervals(b)[i]);

/**
 * A short, human name for a tuning (#83): "Standard", "C# Standard", "Drop D", "Drop C#", a
 * known preset's name without the instrument ("Open G"), or null for a custom tuning. Standard
 * and drop tunings are recognised in any key, for guitars of 4 to 10 strings and for basses.
 */
export function shortTuningName(tuning: readonly number[]): string | null {
  const n = tuning.length;
  if (n < 2) return null;
  const note = (pitch: number) => pitchName(pitch, { octave: false });
  const shapes = [STANDARD_STRINGS.slice(0, n), STANDARD_BASS[n]].filter(
    (shape): shape is number[] => !!shape && shape.length === n,
  );
  for (const shape of shapes) {
    const low = tuning[n - 1]!;
    if (sameSteps(tuning, shape)) {
      const offset = low - shape[n - 1]!;
      if (Math.abs(offset) <= 12) return offset === 0 ? "Standard" : `${note(low)} Standard`;
    }
    // Drop: standard above, the lowest string a whole step further down.
    const raised = [...tuning.slice(0, -1), low + 2];
    if (sameSteps(raised, shape) && Math.abs(raised[n - 1]! - shape[n - 1]!) <= 12) {
      return `Drop ${note(low)}`;
    }
  }
  const known = tuningName(tuning);
  if (!known) return null;
  return known.replace(/^(Guitar|Bass|Banjo|Mandolin|Ukulele)\s+/i, "").replace(/\s+Tuning$/i, "");
}

/** The tuning's short name, or "Custom tuning" (#83). */
export const tuningLabel = (tuning: readonly number[]) =>
  shortTuningName(tuning) ?? "Custom tuning";

/**
 * A tuning's note names the way players say it, lowest string first: "E A D G B E" (#119).
 * (`tuning` itself is highest string first, like the lines of a tab.)
 */
export const tuningNotes = (tuning: readonly number[]) =>
  [...tuning]
    .reverse()
    .map((pitch) => pitchName(pitch, { octave: false }))
    .join(" ");

/** A tuning for a new string count: keeps the top strings, adds strings a fourth lower. */
export function resizeTuning(tuning: readonly number[], stringCount: number): number[] {
  const standard = tuningPresets(stringCount)[0]?.tuning;
  if (tuning.length === 0) return standard ?? STANDARD_GUITAR.slice(0, stringCount);
  const next = tuning.slice(0, stringCount);
  while (next.length < stringCount) next.push(Math.max(0, next.at(-1)! - 5));
  return next;
}

export interface DrumSound {
  /**
   * alphaTab articulation id (Guitar Pro 7's). For the common kit pieces it is
   * also the General MIDI percussion key.
   */
  id: number;
  name: string;
  /** Short label for the pads. */
  short: string;
}

/**
 * The drum kit Smart Beat writes with: the standard Guitar Pro drum-kit
 * notation (alphaTab's defaults decide the staff line and notehead of each
 * sound). Listed from the bottom of the kit to the cymbals.
 */
export const DRUM_KIT: DrumSound[] = [
  { id: 36, name: "Kick drum", short: "Kick" },
  { id: 35, name: "Acoustic kick drum", short: "Kick 2" },
  { id: 38, name: "Snare", short: "Snare" },
  { id: 37, name: "Snare (side stick)", short: "Stick" },
  { id: 43, name: "Floor tom (very low)", short: "Tom 5" },
  { id: 45, name: "Low tom", short: "Tom 4" },
  { id: 47, name: "Mid tom", short: "Tom 3" },
  { id: 48, name: "High tom", short: "Tom 2" },
  { id: 50, name: "Very high tom", short: "Tom 1" },
  { id: 42, name: "Hi-hat (closed)", short: "HH" },
  { id: 46, name: "Hi-hat (open)", short: "HH open" },
  { id: 44, name: "Hi-hat (pedal)", short: "HH pedal" },
  { id: 51, name: "Ride cymbal", short: "Ride" },
  { id: 53, name: "Ride (bell)", short: "Bell" },
  { id: 49, name: "Crash cymbal", short: "Crash" },
  { id: 57, name: "Crash cymbal 2", short: "Crash 2" },
  { id: 55, name: "Splash cymbal", short: "Splash" },
  { id: 52, name: "China cymbal", short: "China" },
  { id: 56, name: "Cowbell", short: "Cowbell" },
  { id: 54, name: "Tambourine", short: "Tamb." },
];

export const drumSound = (id: number) => DRUM_KIT.find((d) => d.id === id);

/**
 * Where the standard drum-kit notation puts each sound on the five-line staff
 * (0 = top line, counting half steps down; negative = above the staff) and
 * which notehead it uses. Mirrors alphaTab's GP7 defaults.
 */
export const DRUM_NOTATION: Record<number, { staffLine: number; notehead: string }> = {
  36: { staffLine: 7, notehead: "Normal" },
  35: { staffLine: 8, notehead: "Normal" },
  38: { staffLine: 3, notehead: "Normal" },
  37: { staffLine: 3, notehead: "X" },
  43: { staffLine: 6, notehead: "Normal" },
  45: { staffLine: 5, notehead: "Normal" },
  47: { staffLine: 4, notehead: "Normal" },
  48: { staffLine: 2, notehead: "Normal" },
  50: { staffLine: 1, notehead: "Normal" },
  42: { staffLine: -1, notehead: "X" },
  46: { staffLine: -1, notehead: "Circled X" },
  44: { staffLine: 9, notehead: "X" },
  51: { staffLine: 0, notehead: "X" },
  53: { staffLine: 0, notehead: "Diamond" },
  49: { staffLine: -2, notehead: "Heavy X" },
  57: { staffLine: -1, notehead: "Heavy X" },
  55: { staffLine: -2, notehead: "X" },
  52: { staffLine: -3, notehead: "Heavy X" },
  56: { staffLine: 0, notehead: "Triangle" },
  54: { staffLine: 3, notehead: "Triangle" },
};

/** "Top line", "Space below the 2nd line", "2nd ledger line above"... */
export function describeStaffLine(staffLine: number): string {
  const ordinal = (n: number) =>
    `${n}${["th", "st", "nd", "rd"][n % 10 < 4 && Math.floor(n / 10) !== 1 ? n % 10 : 0]}`;
  if (staffLine < 0) {
    const steps = -staffLine;
    return steps % 2 === 1
      ? steps === 1
        ? "Space above the staff"
        : `Space above ${ordinal((steps - 1) / 2)} ledger line`
      : `${ordinal(steps / 2)} ledger line above`;
  }
  if (staffLine > 8) {
    const steps = staffLine - 8;
    return steps % 2 === 1
      ? steps === 1
        ? "Space below the staff"
        : `Space below ${ordinal((steps - 1) / 2)} ledger line`
      : `${ordinal(steps / 2)} ledger line below`;
  }
  const line = Math.floor(staffLine / 2) + 1;
  return staffLine % 2 === 0
    ? `${ordinal(line)} line from the top`
    : `Space below the ${ordinal(line)} line`;
}
