/**
 * Guitar techniques and other effects (Guitar Pro 5's set) on notes and
 * beats: a catalogue the editor, toolbar and menus share, plus bend and
 * whammy bar curves. alphaTab draws all of them and plays most of them
 * (see `effect-sound.ts` for the rest).
 *
 * Every effect is a number (an alphaTab enum value, or 0/1 for on/off).
 * The first choice is always "off".
 */
import { model } from "@coderline/alphatab";

import type { Beat, Note } from "@/lib/score/model";
import type { TrackKind } from "@/lib/score/music";

const {
  AccentuationType,
  BendPoint,
  CrescendoType,
  DynamicValue,
  BendType,
  BrushType,
  Duration,
  FadeType,
  HarmonicType,
  NoteAccidentalMode,
  Ottavia,
  PickStroke,
  Rasgueado,
  SlideInType,
  SlideOutType,
  TremoloPickingEffect,
  VibratoType,
  WahPedal,
  WhammyType,
} = model;

export interface Choice {
  value: number;
  label: string;
}

interface EffectBase<T> {
  id: string;
  /** "Palm mute". */
  label: string;
  /** Short toolbar text, e.g. "P.M.". */
  short: string;
  /** Tracks it makes sense on. */
  kinds: readonly TrackKind[];
  /** The values it can take; the first one is "off". */
  choices: readonly Choice[];
  /** The value a toggle (key, menu item) switches on. */
  on: number;
  get(target: T): number;
  set(target: T, value: number): void;
}

export type NoteEffect = EffectBase<Note> & { scope: "note" };
export type BeatEffect = EffectBase<Beat> & { scope: "beat" };
export type Effect = NoteEffect | BeatEffect;

const STRINGED = ["stringed"] as const;
const MELODIC = ["stringed", "pitched"] as const;
const ALL = ["stringed", "pitched", "drums"] as const;

const ON_OFF: Choice[] = [
  { value: 0, label: "Off" },
  { value: 1, label: "On" },
];

function noteFlag(
  id: string,
  label: string,
  short: string,
  kinds: readonly TrackKind[],
  get: (note: Note) => boolean,
  set: (note: Note, on: boolean) => void,
): NoteEffect {
  return {
    id,
    label,
    short,
    kinds,
    scope: "note",
    choices: ON_OFF,
    on: 1,
    get: (note) => Number(get(note)),
    set: (note, value) => set(note, value !== 0),
  };
}

function beatFlag(
  id: string,
  label: string,
  short: string,
  get: (beat: Beat) => boolean,
  set: (beat: Beat, on: boolean) => void,
): BeatEffect {
  return {
    id,
    label,
    short,
    kinds: STRINGED,
    scope: "beat",
    choices: ON_OFF,
    on: 1,
    get: (beat) => Number(get(beat)),
    set: (beat, value) => set(beat, value !== 0),
  };
}

/** Semitones to the note a trill alternates with (trillValue is that MIDI pitch). */
const trillBase = (note: Note) => note.calculateRealValue(false, false);

/**
 * alphaTab's harmonic value for a harmonic `deltaFret` frets above the
 * played note (natural harmonics: the fret they are played at).
 */
export function harmonicValue(deltaFret: number): number {
  if (deltaFret === 2) return 2.4;
  if (deltaFret === 3) return 3.2;
  return [4, 5, 7, 9, 12, 16, 17, 19, 24].includes(deltaFret) ? deltaFret : 12;
}

/** Frets where natural harmonics ring (alphaTab gives them a pitch). */
export const NATURAL_HARMONIC_FRETS = [3, 4, 5, 7, 9, 12, 16, 17, 19, 24];

export const NOTE_EFFECTS = {
  hammerPull: noteFlag(
    "hammerPull",
    "Hammer-on / pull-off",
    "H/P",
    STRINGED,
    (n) => n.isHammerPullOrigin,
    (n, on) => {
      n.isHammerPullOrigin = on;
    },
  ),
  slideOut: {
    id: "slideOut",
    label: "Slide",
    short: "Slide",
    kinds: STRINGED,
    scope: "note",
    on: SlideOutType.Shift,
    choices: [
      { value: SlideOutType.None, label: "No slide" },
      { value: SlideOutType.Shift, label: "Shift slide to the next note" },
      { value: SlideOutType.Legato, label: "Legato slide to the next note" },
      { value: SlideOutType.OutDown, label: "Slide out downwards" },
      { value: SlideOutType.OutUp, label: "Slide out upwards" },
      { value: SlideOutType.PickSlideDown, label: "Pick slide down" },
      { value: SlideOutType.PickSlideUp, label: "Pick slide up" },
    ],
    get: (n) => n.slideOutType,
    set: (n, value) => {
      n.slideOutType = value;
      n.slideTarget = null;
    },
  },
  slideIn: {
    id: "slideIn",
    label: "Slide in",
    short: "Slide in",
    kinds: STRINGED,
    scope: "note",
    on: SlideInType.IntoFromBelow,
    choices: [
      { value: SlideInType.None, label: "No slide in" },
      { value: SlideInType.IntoFromBelow, label: "Slide in from below" },
      { value: SlideInType.IntoFromAbove, label: "Slide in from above" },
    ],
    get: (n) => n.slideInType,
    set: (n, value) => {
      n.slideInType = value;
    },
  },
  vibrato: {
    id: "vibrato",
    label: "Vibrato",
    short: "Vib.",
    kinds: MELODIC,
    scope: "note",
    on: VibratoType.Slight,
    choices: [
      { value: VibratoType.None, label: "No vibrato" },
      { value: VibratoType.Slight, label: "Vibrato" },
      { value: VibratoType.Wide, label: "Wide vibrato" },
    ],
    get: (n) => n.vibrato,
    set: (n, value) => {
      n.vibrato = value;
    },
  },
  trill: {
    id: "trill",
    label: "Trill",
    short: "tr",
    kinds: MELODIC,
    scope: "note",
    on: 2,
    choices: [
      { value: 0, label: "No trill" },
      { value: 1, label: "Trill a half step up" },
      { value: 2, label: "Trill a whole step up" },
    ],
    get: (n) => (n.isTrill ? Math.max(0, n.trillValue - trillBase(n)) : 0),
    set: (n, value) => {
      n.trillValue = value > 0 ? trillBase(n) + value : -1;
    },
  },
  trillSpeed: {
    id: "trillSpeed",
    label: "Trill speed",
    short: "Speed",
    kinds: MELODIC,
    scope: "note",
    on: Duration.ThirtySecond,
    choices: [
      { value: Duration.Sixteenth, label: "16th notes" },
      { value: Duration.ThirtySecond, label: "32nd notes" },
      { value: Duration.SixtyFourth, label: "64th notes" },
    ],
    get: (n) => n.trillSpeed,
    set: (n, value) => {
      n.trillSpeed = value;
    },
  },
  palmMute: noteFlag(
    "palmMute",
    "Palm mute",
    "P.M.",
    STRINGED,
    (n) => n.isPalmMute,
    (n, on) => {
      n.isPalmMute = on;
    },
  ),
  letRing: noteFlag(
    "letRing",
    "Let ring",
    "L.R.",
    STRINGED,
    (n) => n.isLetRing,
    (n, on) => {
      n.isLetRing = on;
    },
  ),
  dead: noteFlag(
    "dead",
    "Dead note",
    "✕",
    STRINGED,
    (n) => n.isDead,
    (n, on) => {
      n.isDead = on;
    },
  ),
  ghost: noteFlag(
    "ghost",
    "Ghost note",
    "( )",
    ALL,
    (n) => n.isGhost,
    (n, on) => {
      n.isGhost = on;
    },
  ),
  harmonic: {
    id: "harmonic",
    label: "Harmonic",
    short: "Harm.",
    kinds: STRINGED,
    scope: "note",
    on: HarmonicType.Natural,
    choices: [
      { value: HarmonicType.None, label: "No harmonic" },
      { value: HarmonicType.Natural, label: "Natural harmonic" },
      { value: HarmonicType.Artificial, label: "Artificial harmonic" },
      { value: HarmonicType.Tap, label: "Tapped harmonic" },
      { value: HarmonicType.Pinch, label: "Pinch harmonic" },
      { value: HarmonicType.Semi, label: "Semi-harmonic" },
    ],
    get: (n) => n.harmonicType,
    set: (n, value) => {
      n.harmonicType = value;
      // Natural harmonics ring at the fret played; the others an octave up.
      n.harmonicValue =
        value === HarmonicType.None
          ? 0
          : value === HarmonicType.Natural
            ? harmonicValue(n.fret)
            : harmonicValue(12);
    },
  },
  accent: {
    id: "accent",
    label: "Accent",
    short: ">",
    kinds: ALL,
    scope: "note",
    on: AccentuationType.Normal,
    choices: [
      { value: AccentuationType.None, label: "No accent" },
      { value: AccentuationType.Normal, label: "Accent" },
      { value: AccentuationType.Heavy, label: "Heavy accent" },
      { value: AccentuationType.Tenuto, label: "Tenuto" },
    ],
    get: (n) => n.accentuated,
    set: (n, value) => {
      n.accentuated = value;
    },
  },
  staccato: noteFlag(
    "staccato",
    "Staccato",
    "Stacc.",
    MELODIC,
    (n) => n.isStaccato,
    (n, on) => {
      n.isStaccato = on;
    },
  ),
  accidental: {
    id: "accidental",
    label: "Accidental",
    short: "♯/♭",
    kinds: MELODIC,
    scope: "note",
    on: NoteAccidentalMode.ForceSharp,
    choices: [
      { value: NoteAccidentalMode.Default, label: "Automatic accidental" },
      { value: NoteAccidentalMode.ForceSharp, label: "Sharp" },
      { value: NoteAccidentalMode.ForceFlat, label: "Flat" },
      { value: NoteAccidentalMode.ForceNatural, label: "Natural" },
      { value: NoteAccidentalMode.ForceDoubleSharp, label: "Double sharp" },
      { value: NoteAccidentalMode.ForceDoubleFlat, label: "Double flat" },
    ],
    get: (n) => n.accidentalMode,
    set: (n, value) => {
      n.accidentalMode = value;
    },
  },
  leftHandTap: noteFlag(
    "leftHandTap",
    "Left-hand tapping",
    "LH tap",
    STRINGED,
    (n) => n.isLeftHandTapped,
    (n, on) => {
      n.isLeftHandTapped = on;
    },
  ),
} satisfies Record<string, NoteEffect>;

const RASGUEADO_LABELS: [model.Rasgueado, string][] = [
  [Rasgueado.Ii, "ii"],
  [Rasgueado.Mi, "mi"],
  [Rasgueado.MiiTriplet, "mii (triplet)"],
  [Rasgueado.MiiAnapaest, "mii (anapaest)"],
  [Rasgueado.PmpTriplet, "pmp (triplet)"],
  [Rasgueado.PmpAnapaest, "pmp (anapaest)"],
  [Rasgueado.PeiTriplet, "pei (triplet)"],
  [Rasgueado.PeiAnapaest, "pei (anapaest)"],
  [Rasgueado.PaiTriplet, "pai (triplet)"],
  [Rasgueado.PaiAnapaest, "pai (anapaest)"],
  [Rasgueado.AmiTriplet, "ami (triplet)"],
  [Rasgueado.AmiAnapaest, "ami (anapaest)"],
  [Rasgueado.Ppp, "ppp"],
  [Rasgueado.Amii, "amii"],
  [Rasgueado.Amip, "amip"],
  [Rasgueado.Eami, "eami"],
  [Rasgueado.Eamii, "eamii"],
  [Rasgueado.Peami, "peami"],
];

/** How long a brush or arpeggio takes (alphaTab's value for Guitar Pro 5's default). */
const BRUSH_DURATION = 60;

export const BEAT_EFFECTS = {
  tap: beatFlag(
    "tap",
    "Tapping",
    "T",
    (b) => b.tap,
    (b, on) => {
      b.tap = on;
    },
  ),
  slap: beatFlag(
    "slap",
    "Slap",
    "S",
    (b) => b.slap,
    (b, on) => {
      b.slap = on;
    },
  ),
  pop: beatFlag(
    "pop",
    "Pop",
    "P",
    (b) => b.pop,
    (b, on) => {
      b.pop = on;
    },
  ),
  tremolo: {
    id: "tremolo",
    label: "Tremolo picking",
    short: "Trem.",
    kinds: MELODIC,
    scope: "beat",
    on: 2,
    choices: [
      { value: 0, label: "No tremolo picking" },
      { value: 1, label: "Tremolo picking in 8th notes" },
      { value: 2, label: "Tremolo picking in 16th notes" },
      { value: 3, label: "Tremolo picking in 32nd notes" },
    ],
    get: (b) => b.tremoloPicking?.marks ?? 0,
    set: (b, value) => {
      b.tremoloPicking =
        value > 0 ? Object.assign(new TremoloPickingEffect(), { marks: value }) : undefined;
    },
  },
  fade: {
    id: "fade",
    label: "Fade",
    short: "Fade",
    kinds: MELODIC,
    scope: "beat",
    on: FadeType.FadeIn,
    choices: [
      { value: FadeType.None, label: "No fade" },
      { value: FadeType.FadeIn, label: "Fade in" },
      { value: FadeType.FadeOut, label: "Fade out" },
      { value: FadeType.VolumeSwell, label: "Volume swell" },
    ],
    get: (b) => b.fade,
    set: (b, value) => {
      b.fade = value;
    },
  },
  brush: {
    id: "brush",
    label: "Brush / arpeggio",
    short: "Brush",
    kinds: MELODIC,
    scope: "beat",
    on: BrushType.BrushDown,
    choices: [
      { value: BrushType.None, label: "No brush or arpeggio" },
      { value: BrushType.BrushDown, label: "Brush down" },
      { value: BrushType.BrushUp, label: "Brush up" },
      { value: BrushType.ArpeggioDown, label: "Arpeggio down" },
      { value: BrushType.ArpeggioUp, label: "Arpeggio up" },
    ],
    get: (b) => b.brushType,
    set: (b, value) => {
      b.brushType = value;
      b.brushDuration = value === BrushType.None ? 0 : b.brushDuration || BRUSH_DURATION;
    },
  },
  rasgueado: {
    id: "rasgueado",
    label: "Rasgueado",
    short: "Rasg.",
    kinds: STRINGED,
    scope: "beat",
    on: Rasgueado.Ii,
    choices: [
      { value: Rasgueado.None, label: "No rasgueado" },
      ...RASGUEADO_LABELS.map(([value, label]) => ({ value, label: `Rasgueado ${label}` })),
    ],
    get: (b) => b.rasgueado,
    set: (b, value) => {
      b.rasgueado = value;
    },
  },
  pickStroke: {
    id: "pickStroke",
    label: "Pick stroke",
    short: "Pick",
    kinds: STRINGED,
    scope: "beat",
    on: PickStroke.Down,
    choices: [
      { value: PickStroke.None, label: "No pick stroke" },
      { value: PickStroke.Down, label: "Downstroke" },
      { value: PickStroke.Up, label: "Upstroke" },
    ],
    get: (b) => b.pickStroke,
    set: (b, value) => {
      b.pickStroke = value;
    },
  },
  wah: {
    id: "wah",
    label: "Wah",
    short: "Wah",
    kinds: STRINGED,
    scope: "beat",
    on: WahPedal.Open,
    choices: [
      { value: WahPedal.None, label: "No wah" },
      { value: WahPedal.Open, label: "Wah open" },
      { value: WahPedal.Closed, label: "Wah closed" },
    ],
    get: (b) => b.wahPedal,
    set: (b, value) => {
      b.wahPedal = value;
    },
  },
  dynamics: {
    id: "dynamics",
    label: "Dynamics",
    short: "dyn.",
    kinds: ALL,
    scope: "beat",
    // Forte is how alphaTab writes a beat without a marking: it counts as "off".
    on: DynamicValue.MF,
    choices: [
      { value: DynamicValue.F, label: "Forte (f)" },
      { value: DynamicValue.PPP, label: "Pianississimo (ppp)" },
      { value: DynamicValue.PP, label: "Pianissimo (pp)" },
      { value: DynamicValue.P, label: "Piano (p)" },
      { value: DynamicValue.MP, label: "Mezzo-piano (mp)" },
      { value: DynamicValue.MF, label: "Mezzo-forte (mf)" },
      { value: DynamicValue.FF, label: "Fortissimo (ff)" },
      { value: DynamicValue.FFF, label: "Fortississimo (fff)" },
    ],
    get: (b) => b.dynamics,
    set: (b, value) => {
      b.dynamics = value;
      for (const note of b.notes) note.dynamics = value;
    },
  },
  crescendo: {
    id: "crescendo",
    label: "Crescendo / decrescendo",
    short: "cresc.",
    kinds: ALL,
    scope: "beat",
    on: CrescendoType.Crescendo,
    choices: [
      { value: CrescendoType.None, label: "No hairpin" },
      { value: CrescendoType.Crescendo, label: "Crescendo" },
      { value: CrescendoType.Decrescendo, label: "Decrescendo" },
    ],
    get: (b) => b.crescendo,
    set: (b, value) => {
      b.crescendo = value;
    },
  },
  ottava: {
    id: "ottava",
    label: "Ottava",
    short: "8va",
    kinds: MELODIC,
    scope: "beat",
    on: Ottavia._8va,
    choices: [
      { value: Ottavia.Regular, label: "No ottava" },
      { value: Ottavia._8va, label: "8va (an octave higher)" },
      { value: Ottavia._8vb, label: "8vb (an octave lower)" },
      { value: Ottavia._15ma, label: "15ma (two octaves higher)" },
      { value: Ottavia._15mb, label: "15mb (two octaves lower)" },
    ],
    get: (b) => b.ottava,
    set: (b, value) => {
      b.ottava = value;
    },
  },
} satisfies Record<string, BeatEffect>;

export type NoteEffectId = keyof typeof NOTE_EFFECTS;
export type BeatEffectId = keyof typeof BEAT_EFFECTS;

export const effectOff = (effect: Effect) => effect.choices[0]!.value;

export const choiceLabel = (effect: Effect, value: number) =>
  effect.choices.find((c) => c.value === value)?.label ?? effect.label;

const isFlag = (effect: Effect) => effect.choices === ON_OFF;

/** What an effect's value is called: "Palm mute on", "Wide vibrato", "Vibrato off". */
export function effectText(effect: Effect, value: number): string {
  if (value === effectOff(effect)) return `${effect.label} off`;
  return isFlag(effect) ? `${effect.label} on` : choiceLabel(effect, value);
}

/** The effect's name when it is on, for the cursor description: "palm mute", "wide vibrato". */
export const activeEffectName = (effect: Effect, value: number) =>
  (isFlag(effect) ? effect.label : choiceLabel(effect, value)).toLowerCase();

/** Why an effect can't be used on a kind of track. */
export function unavailableText(effect: Effect): string {
  return effect.kinds.includes("pitched")
    ? `${effect.label} isn't available on drum tracks`
    : `${effect.label} is only available on tab tracks`;
}

/** Whether an effect can be used on a kind of track. */
export const effectAvailable = (effect: Effect, kind: TrackKind) => effect.kinds.includes(kind);

// --- Bend and whammy bar curves ---------------------------------------------

/** A point of a bend or whammy curve. */
export interface CurvePoint {
  /** Position within the note, 0 (start) to {@link CURVE_LENGTH} (end). */
  offset: number;
  /** Pitch in quarter tones (4 = a whole step); negative for whammy dives. */
  value: number;
}

/** alphaTab's (and Guitar Pro's) curve length. */
export const CURVE_LENGTH = 60;
/** Highest bend: three whole steps. */
export const MAX_BEND = 12;
/** Deepest whammy dive and highest pull-up, in quarter tones. */
export const MAX_WHAMMY = 12;

export interface CurvePreset {
  id: string;
  label: string;
  points: (amount: number) => CurvePoint[];
}

const p = (offset: number, value: number): CurvePoint => ({ offset, value });

/** Bend shapes, as Guitar Pro offers them. The amount is the bend's height. */
export const BEND_PRESETS: CurvePreset[] = [
  { id: "bend", label: "Bend", points: (a) => [p(0, 0), p(15, a), p(60, a)] },
  {
    id: "bend-release",
    label: "Bend and release",
    points: (a) => [p(0, 0), p(15, a), p(30, a), p(45, 0)],
  },
  {
    id: "bend-release-bend",
    label: "Bend, release, bend",
    points: (a) => [p(0, 0), p(10, a), p(20, a), p(30, 0), p(40, 0), p(50, a)],
  },
  { id: "prebend", label: "Pre-bend", points: (a) => [p(0, a), p(60, a)] },
  {
    id: "prebend-release",
    label: "Pre-bend and release",
    points: (a) => [p(0, a), p(15, a), p(30, 0), p(60, 0)],
  },
];

/** Whammy bar shapes. The amount is how far the pitch goes down. */
export const WHAMMY_PRESETS: CurvePreset[] = [
  { id: "dive", label: "Dive", points: (a) => [p(0, 0), p(45, -a)] },
  { id: "dip", label: "Dip", points: (a) => [p(0, 0), p(15, -a), p(30, 0)] },
  { id: "predive", label: "Pre-dive", points: (a) => [p(0, -a), p(60, -a)] },
  { id: "release", label: "Release up", points: (a) => [p(0, -a), p(45, 0)] },
  { id: "predive-dive", label: "Pre-dive and dive", points: (a) => [p(0, -a), p(45, -2 * a)] },
];

/** Bend heights to choose from (quarter tones). */
export const BEND_AMOUNTS: Choice[] = [
  { value: 1, label: "¼ step" },
  { value: 2, label: "½ step" },
  { value: 4, label: "Full step" },
  { value: 6, label: "1½ steps" },
  { value: 8, label: "2 steps" },
  { value: 12, label: "3 steps" },
];

const toPoints = (points: model.BendPoint[] | null): CurvePoint[] | null =>
  points && points.length > 0 ? points.map((pt) => ({ offset: pt.offset, value: pt.value })) : null;

const sortPoints = (points: readonly CurvePoint[]) =>
  [...points]
    .map((pt) => ({
      offset: Math.min(CURVE_LENGTH, Math.max(0, Math.round(pt.offset))),
      value: Math.round(pt.value),
    }))
    .sort((a, b) => a.offset - b.offset);

export const bendOf = (note: Note): CurvePoint[] | null =>
  note.hasBend ? toPoints(note.bendPoints) : null;

/**
 * Sets a note's bend (null removes it). New point objects every time, never
 * changed in place, so undo snapshots stay valid; alphaTab works out the
 * bend type from the points.
 */
export function setBend(note: Note, points: readonly CurvePoint[] | null): void {
  note.bendPoints = null;
  note.maxBendPoint = null;
  note.bendType = BendType.None;
  if (!points || points.length < 2) return;
  for (const pt of sortPoints(points)) {
    note.addBendPoint(new BendPoint(pt.offset, Math.min(MAX_BEND, Math.max(0, pt.value))));
  }
}

export const whammyOf = (beat: Beat): CurvePoint[] | null =>
  beat.hasWhammyBar ? toPoints(beat.whammyBarPoints) : null;

/** Sets a beat's whammy bar curve (null removes it). */
export function setWhammy(beat: Beat, points: readonly CurvePoint[] | null): void {
  beat.whammyBarPoints = null;
  beat.maxWhammyPoint = null;
  beat.minWhammyPoint = null;
  beat.whammyBarType = WhammyType.None;
  if (!points || points.length < 2) return;
  for (const pt of sortPoints(points)) {
    beat.addWhammyBarPoint(
      new BendPoint(pt.offset, Math.min(MAX_WHAMMY, Math.max(-MAX_WHAMMY, pt.value))),
    );
  }
}

/** "full step", "½ step", "1½ steps", in words for a bend of `value` quarter tones. */
export function stepsText(value: number): string {
  const steps = Math.abs(value) / 4;
  if (steps === 1) return "full step";
  if (steps === 0.25) return "¼ step";
  if (steps === 0.5) return "½ step";
  if (steps === 0.75) return "¾ step";
  const whole = Math.floor(steps);
  const rest = steps - whole;
  const fraction = rest === 0.5 ? "½" : rest === 0.25 ? "¼" : rest === 0.75 ? "¾" : "";
  return `${whole}${fraction} steps`;
}

/** A spoken summary of a curve, e.g. "up a full step, then back down". */
export function describeCurve(points: readonly CurvePoint[] | null): string {
  if (!points || points.length < 2) return "None";
  const values = points.map((pt) => pt.value);
  const peak = values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  const start = values[0]!;
  const end = values.at(-1)!;
  const direction = peak >= 0 ? "up" : "down";
  if (start !== 0 && end === start) return `Held ${stepsText(start)} ${start > 0 ? "up" : "down"}`;
  if (start !== 0 && end === 0)
    return `Starts ${stepsText(start)} ${start > 0 ? "up" : "down"}, released`;
  if (end === 0 && peak !== 0) return `${stepsText(peak)} ${direction} and back`;
  return `${stepsText(end || peak)} ${direction}`;
}
