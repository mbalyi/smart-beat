/**
 * The edit palette as data: sections of rows of icon-only cells, and boxes (a cell that opens a
 * small grid of variants). Every item names the editor action it runs; the palette component
 * (`edit-palette.tsx`) maps an action to the workspace's handlers and to the pressed state.
 *
 * Only what the editor can do today is listed. Names, marks and shortcuts follow the effect
 * catalogue (`effects.ts`), so the buttons are named the same as in the menus and the status line.
 */
import { model } from "@coderline/alphatab";

import {
  BEAT_EFFECTS,
  choiceLabel,
  NOTE_EFFECTS,
  type BeatEffectId,
  type Effect,
  type NoteEffectId,
} from "@/lib/score/effects";
import {
  describeAccidentals,
  KEY_SIGNATURES,
  keyName,
  type KeySignature,
  type KeySignatureType,
} from "@/lib/score/keys";
import {
  NOTE_VALUES,
  TUPLETS,
  tupletKey,
  type Duration,
  type TrackKind,
  type Tuplet,
} from "@/lib/score/music";
import type { SmuflName } from "@/lib/score/smufl";
import {
  DIRECTIONS,
  MAX_ENDINGS,
  TRIPLET_FEELS,
  type DirectionType,
  type TempoMark,
  type TimeSignature,
  type TripletFeelType,
} from "@/lib/score/structure";

const {
  AccentuationType,
  BrushType,
  CrescendoType,
  DynamicValue,
  Duration: DurationValue,
  FadeType,
  GraceType,
  HarmonicType,
  KeySignatureType: KeyType,
  NoteAccidentalMode,
  Ottavia,
  PickStroke,
  SlideInType,
  SlideOutType,
  TripletFeel,
  VibratoType,
  WahPedal,
} = model;

/** Lucide icons the palette uses where music notation has no symbol. */
export type PaletteIconName =
  | "tie"
  | "fillRests"
  | "insertBeat"
  | "deleteBeat"
  | "bar"
  | "bend"
  | "whammy"
  | "text"
  | "chord"
  | "lyrics"
  | "shortcuts"
  | "nested";

/** What a cell shows: Bravura glyphs, an icon, or a mark written as text. Never a label. */
export interface PaletteVisual {
  glyph?: SmuflName | readonly SmuflName[];
  /** Extra Tailwind classes for the glyph (size and baseline tweaks). */
  glyphClass?: string;
  /** A smaller glyph, for wide symbols. */
  small?: boolean;
  icon?: PaletteIconName;
  /** A written mark in italic serif type (P.M., L.R., D.S.S.). */
  mark?: string;
  /** Plain bold text (the "=120" of a tempo, the "3:2" of a tuplet). */
  text?: string;
  /** A second line under `mark`, for two-line jump marks (D.C. al Coda). */
  sub?: { text?: string; glyph?: SmuflName | readonly SmuflName[] };
  /** A time signature as stacked Bravura digits. */
  digits?: readonly [number, number];
}

/** What a cell does. The palette component maps each one to a workspace handler. */
export type PaletteAction =
  | { type: "duration"; duration: Duration }
  | { type: "dots"; count: 1 | 2 }
  | { type: "rest" }
  | { type: "fillRests" }
  | { type: "tie" }
  | { type: "insertBeat" }
  | { type: "deleteBeat" }
  | { type: "voice"; voice: number }
  | { type: "tuplet"; tuplet: Tuplet }
  | { type: "nestedTuplet" }
  | { type: "bar" }
  | { type: "key"; signature: KeySignature; keyType: KeySignatureType }
  | { type: "time"; time: TimeSignature }
  | { type: "tempo"; tempo: TempoMark }
  | { type: "feel"; feel: TripletFeelType }
  | { type: "ending"; ending: number }
  | { type: "jump"; direction: DirectionType }
  | { type: "repeat"; side: "start" | "end" }
  | { type: "noteEffect"; id: NoteEffectId; value?: number }
  | { type: "beatEffect"; id: BeatEffectId; value?: number }
  | { type: "grace"; grace: number }
  | { type: "fermata" }
  | { type: "bend" }
  | { type: "whammy" }
  | { type: "text" }
  | { type: "chord" }
  | { type: "lyrics" }
  | { type: "shortcuts" };

export interface PaletteItem {
  /** Unique in the whole palette. */
  id: string;
  /** The name: tooltip and accessible name. */
  label: string;
  /** The written mark the icon shows; it is part of the accessible name (WCAG 2.5.3). */
  mark?: string;
  shortcut?: string;
  visual: PaletteVisual;
  action: PaletteAction;
  /** Columns the item takes in a box (tempo presets are two wide). */
  span?: number;
  /** The "off" choice of a family (no triplet feel, no tuplet): it is not shown as active. */
  neutral?: boolean;
}

export interface PaletteGroup {
  /** Named group in a box ("Major", "Jump targets"); `undefined` for a single group. */
  label?: string;
  items: PaletteItem[];
}

/** A cell that opens a box of variants; the pick stays in the cell. */
export interface PaletteBox {
  id: string;
  /** The family name: "Slide", "Key signature". Names the cell and the box. */
  label: string;
  groups: PaletteGroup[];
  /** Columns of the box grid (cells of 34px). */
  columns: number;
  /** Shown while nothing of the box is on and nothing was picked. */
  idle?: PaletteVisual;
  /** A setting that always has a value (key, time): the cell shows it and is never "on". */
  setting?: boolean;
  /** Extra controls under the grid: the beats and unit inputs of the time signature. */
  footer?: "time";
}

export type PaletteEntry = { cell: PaletteItem } | { box: PaletteBox };

export interface PaletteRow {
  /** A small header over this row and the rows after it, until the next header. */
  heading?: string;
  entries: PaletteEntry[];
  /** The cells of the row are the choices of one radio group of this name (note values). */
  radioLabel?: string;
}

export interface PaletteSection {
  id: string;
  /** Names the group of cells. */
  label: string;
  /** Which of the two toolbars of the palette holds it. */
  toolbar: "Edit" | "Effects";
  rows: PaletteRow[];
}

// --- builders -----------------------------------------------------------------------------------

const cell = (item: PaletteItem): PaletteEntry => ({ cell: item });
const box = (b: PaletteBox): PaletteEntry => ({ box: b });

interface Options {
  label?: string;
  shortcut?: string;
  mark?: string;
  span?: number;
  neutral?: boolean;
}

const effectLabel = (effect: Effect, value: number | undefined, label?: string) =>
  label ?? (value === undefined ? effect.label : choiceLabel(effect, value));

/** A note effect: a toggle, or (with `value`) one value of the effect. */
function noteItem(
  id: NoteEffectId,
  visual: PaletteVisual,
  { value, ...o }: Options & { value?: number } = {},
): PaletteItem {
  const effect = NOTE_EFFECTS[id] as Effect;
  return {
    id: `note:${id}${value === undefined ? "" : `:${value}`}`,
    label: effectLabel(effect, value, o.label),
    mark: o.mark,
    shortcut: o.shortcut,
    span: o.span,
    neutral: o.neutral,
    visual,
    action: { type: "noteEffect", id, value },
  };
}

/** A beat effect: a toggle, or (with `value`) one value of the effect. */
function beatItem(
  id: BeatEffectId,
  visual: PaletteVisual,
  { value, ...o }: Options & { value?: number } = {},
): PaletteItem {
  const effect = BEAT_EFFECTS[id] as Effect;
  return {
    id: `beat:${id}${value === undefined ? "" : `:${value}`}`,
    label: effectLabel(effect, value, o.label),
    mark: o.mark,
    shortcut: o.shortcut,
    span: o.span,
    neutral: o.neutral,
    visual,
    action: { type: "beatEffect", id, value },
  };
}

const glyph = (name: SmuflName | readonly SmuflName[], glyphClass?: string): PaletteVisual => ({
  glyph: name,
  glyphClass,
});

const plain = (
  id: string,
  label: string,
  visual: PaletteVisual,
  action: PaletteAction,
  o: Options = {},
): PaletteItem => ({ id, label, visual, action, ...o });

/** Articulations and dots are tiny glyphs: drawn bigger (the palette centres the ink itself). */
const ARTIC = "text-[2.2rem]";
const DOT = "text-[2.2rem]";
const SMALL = "text-base";

// --- bar level boxes ----------------------------------------------------------------------------

const keyVisual = (signature: number): PaletteVisual =>
  signature === 0
    ? glyph("accidentalNatural", SMALL)
    : {
        text: String(Math.abs(signature)),
        glyph: signature > 0 ? "accidentalSharp" : "accidentalFlat",
        glyphClass: SMALL,
      };

const keyItems = (keyType: KeySignatureType): PaletteItem[] =>
  KEY_SIGNATURES.map(({ signature }) => ({
    id: `key:${keyType === KeyType.Minor ? "minor" : "major"}:${signature}`,
    label:
      signature === 0
        ? keyName(signature, keyType, { spoken: true })
        : `${keyName(signature, keyType, { spoken: true })}, ${describeAccidentals(signature)}`,
    visual: keyVisual(signature),
    action: { type: "key", signature, keyType },
  }));

const KEY_BOX: PaletteBox = {
  id: "key",
  label: "Key signature",
  columns: 5,
  setting: true,
  groups: [
    { label: "Major", items: keyItems(KeyType.Major) },
    { label: "Minor", items: keyItems(KeyType.Minor) },
  ],
};

/** The time signatures offered as presets; any other one is typed in the box. */
const TIME_PRESETS: TimeSignature[] = [
  [2, 4],
  [3, 4],
  [4, 4],
  [5, 4],
  [6, 4],
  [7, 4],
  [3, 8],
  [5, 8],
  [6, 8],
  [7, 8],
  [9, 8],
  [12, 8],
  [2, 2],
  [3, 2],
].map(([numerator, denominator]) => ({ numerator: numerator!, denominator: denominator! }));

const TIME_BOX: PaletteBox = {
  id: "time",
  label: "Time signature",
  columns: 6,
  setting: true,
  footer: "time",
  groups: [
    {
      items: TIME_PRESETS.map((time) => ({
        id: `time:${time.numerator}/${time.denominator}`,
        label: `${time.numerator}/${time.denominator} time`,
        visual: { digits: [time.numerator, time.denominator] as const },
        action: { type: "time", time },
      })),
    },
  ],
};

const TEMPO_PRESETS: TempoMark[] = [
  { bpm: 60, label: "Largo" },
  { bpm: 76, label: "Adagio" },
  { bpm: 100, label: "Andante" },
  { bpm: 120, label: "Moderato" },
  { bpm: 144, label: "Allegro" },
  { bpm: 176, label: "Presto" },
];

const TEMPO_BOX: PaletteBox = {
  id: "tempo",
  label: "Tempo",
  columns: 6,
  idle: { glyph: "noteQuarterUp", small: true, text: "=" },
  groups: [
    {
      items: TEMPO_PRESETS.map((tempo) => ({
        id: `tempo:${tempo.bpm}`,
        label: `${tempo.label}, ${tempo.bpm} BPM`,
        visual: { glyph: "noteQuarterUp", small: true, text: `=${tempo.bpm}` },
        action: { type: "tempo", tempo },
        span: 2,
      })),
    },
  ],
};

const FEEL_VISUALS: Record<number, PaletteVisual> = {
  [TripletFeel.NoTripletFeel]: { glyph: ["note8thUp", "note8thUp"], small: true },
  [TripletFeel.Triplet8th]: { glyph: ["tuplet3", "note8thUp"], small: true },
  [TripletFeel.Triplet16th]: { glyph: ["tuplet3", "note16thUp"], small: true },
  [TripletFeel.Dotted8th]: { glyph: ["note8thUp", "augmentationDot"], small: true },
  [TripletFeel.Dotted16th]: { glyph: ["note16thUp", "augmentationDot"], small: true },
  [TripletFeel.Scottish8th]: {
    glyph: ["note16thUp", "note8thUp", "augmentationDot"],
    small: true,
  },
  [TripletFeel.Scottish16th]: {
    glyph: ["note32ndUp", "note16thUp", "augmentationDot"],
    small: true,
  },
};

const FEEL_BOX: PaletteBox = {
  id: "feel",
  label: "Triplet feel",
  columns: 4,
  groups: [
    {
      items: TRIPLET_FEELS.map(({ value, label }) => ({
        id: `feel:${value}`,
        label: value === TripletFeel.NoTripletFeel ? "No triplet feel" : `Triplet feel: ${label}`,
        visual: FEEL_VISUALS[value] ?? { text: label },
        action: { type: "feel", feel: value },
        neutral: value === TripletFeel.NoTripletFeel,
      })),
    },
  ],
};

const ENDINGS_BOX: PaletteBox = {
  id: "endings",
  label: "Alternate endings",
  columns: 4,
  idle: { text: "1." },
  groups: [
    {
      items: Array.from({ length: MAX_ENDINGS }, (_, i) => ({
        id: `ending:${i + 1}`,
        label: `Ending ${i + 1}`,
        visual: { text: `${i + 1}.` },
        action: { type: "ending", ending: i + 1 } as PaletteAction,
      })),
    },
  ],
};

/** Every jump and jump target the editor has, with the sign each one is written with. */
const JUMP_VISUALS: Partial<Record<DirectionType, PaletteVisual>> = (() => {
  const D = model.Direction;
  const coda = (jump: string, text?: string): PaletteVisual => ({
    mark: jump,
    sub: { text, glyph: "coda" },
  });
  const twoCodas = (jump: string): PaletteVisual => ({
    mark: jump,
    sub: { text: "al", glyph: ["coda", "coda"] },
  });
  const fine = (jump: string): PaletteVisual => ({ mark: jump, sub: { text: "al Fine" } });
  return {
    [D.TargetSegno]: { glyph: "segno", small: true },
    [D.TargetSegnoSegno]: { glyph: ["segno", "segno"], small: true },
    [D.TargetCoda]: { glyph: "coda", small: true },
    [D.TargetDoubleCoda]: { glyph: ["coda", "coda"], small: true },
    [D.TargetFine]: { mark: "Fine" },
    [D.JumpDaCapo]: { glyph: "daCapo", small: true },
    [D.JumpDaCapoAlCoda]: coda("D.C.", "al"),
    [D.JumpDaCapoAlDoubleCoda]: twoCodas("D.C."),
    [D.JumpDaCapoAlFine]: fine("D.C."),
    [D.JumpDalSegno]: { glyph: "dalSegno", small: true },
    [D.JumpDalSegnoAlCoda]: coda("D.S.", "al"),
    [D.JumpDalSegnoAlDoubleCoda]: twoCodas("D.S."),
    [D.JumpDalSegnoAlFine]: fine("D.S."),
    [D.JumpDalSegnoSegno]: { mark: "D.S.S." },
    [D.JumpDalSegnoSegnoAlCoda]: coda("D.S.S.", "al"),
    [D.JumpDalSegnoSegnoAlDoubleCoda]: twoCodas("D.S.S."),
    [D.JumpDalSegnoSegnoAlFine]: fine("D.S.S."),
    [D.JumpDaCoda]: { mark: "To", sub: { glyph: "coda" } },
    [D.JumpDaDoubleCoda]: { mark: "To", sub: { glyph: ["coda", "coda"] } },
  };
})();

const jumpItem = (direction: (typeof DIRECTIONS)[number]): PaletteItem => ({
  id: `jump:${direction.value}`,
  label: direction.spoken,
  visual: JUMP_VISUALS[direction.value] ?? { mark: direction.label },
  action: { type: "jump", direction: direction.value },
});

const JUMPS_BOX: PaletteBox = {
  id: "jumps",
  label: "Jumps",
  columns: 6,
  idle: { glyph: "segno", small: true },
  groups: [
    { label: "Jump targets", items: DIRECTIONS.filter((d) => d.kind === "target").map(jumpItem) },
    {
      label: "Jump instructions",
      items: DIRECTIONS.filter((d) => d.kind === "jump").map(jumpItem),
    },
  ],
};

// --- note level boxes ---------------------------------------------------------------------------

const OCTAVE_BOX: PaletteBox = {
  id: "octave",
  label: "Octave line",
  columns: 4,
  idle: glyph("ottavaAlta", SMALL),
  groups: [
    {
      items: [
        beatItem("ottava", glyph("ottavaAlta", SMALL), {
          value: Ottavia._8va,
          label: "8va (an octave higher)",
        }),
        beatItem("ottava", glyph("ottavaBassaVb", SMALL), {
          value: Ottavia._8vb,
          label: "8vb (an octave lower)",
        }),
        beatItem("ottava", glyph("quindicesimaAlta", SMALL), {
          value: Ottavia._15ma,
          label: "15ma (two octaves higher)",
        }),
        beatItem("ottava", glyph("quindicesimaBassaMb", SMALL), {
          value: Ottavia._15mb,
          label: "15mb (two octaves lower)",
        }),
      ],
    },
  ],
};

const VOICE_BOX: PaletteBox = {
  id: "voice",
  label: "Voice",
  columns: 2,
  setting: true,
  groups: [
    {
      items: [
        plain(
          "voice:1",
          "Voice 1",
          { text: "V1" },
          { type: "voice", voice: 0 },
          {
            shortcut: "V switches",
          },
        ),
        plain(
          "voice:2",
          "Voice 2",
          { text: "V2" },
          { type: "voice", voice: 1 },
          {
            shortcut: "V switches",
          },
        ),
      ],
    },
  ],
};

const TUPLET_BOX: PaletteBox = {
  id: "tuplet",
  label: "Tuplet",
  columns: 6,
  idle: glyph("tuplet3"),
  groups: [
    {
      items: [
        ...TUPLETS.map((tuplet) => {
          const none = tuplet.numerator === 1 && tuplet.denominator === 1;
          return {
            id: `tuplet:${tupletKey(tuplet)}`,
            label: tuplet.label,
            visual:
              tuplet.numerator === 3 ? glyph("tuplet3") : { text: none ? "–" : tupletKey(tuplet) },
            action: { type: "tuplet", tuplet } as PaletteAction,
            neutral: none,
          };
        }),
        plain(
          "tuplet:nested",
          "Nested tuplet",
          { icon: "nested" },
          { type: "nestedTuplet" },
          { neutral: true },
        ),
      ],
    },
  ],
};

const ACCENT_VALUES = AccentuationType;
const ARTICULATION_BOX: PaletteBox = {
  id: "articulation",
  label: "Articulation",
  columns: 4,
  groups: [
    {
      items: [
        noteItem("accent", glyph("articAccentAbove", ARTIC), {
          value: ACCENT_VALUES.Normal,
          shortcut: ">",
        }),
        noteItem("accent", glyph("articMarcatoAbove", ARTIC), {
          value: ACCENT_VALUES.Heavy,
          label: "Heavy accent",
        }),
        noteItem("accent", glyph("articTenutoAbove", ARTIC), { value: ACCENT_VALUES.Tenuto }),
        noteItem("staccato", glyph("articStaccatoAbove", ARTIC)),
      ],
    },
  ],
};

const TRILL_SPEEDS = [
  [DurationValue.Sixteenth, "16"],
  [DurationValue.ThirtySecond, "32"],
  [DurationValue.SixtyFourth, "64"],
] as const;

const TRILL_BOX: PaletteBox = {
  id: "trill",
  label: "Trill",
  columns: 5,
  groups: [
    {
      label: "Interval",
      items: [
        noteItem("trill", { glyph: "ornamentTrill", small: true, text: "½" }, { value: 1 }),
        noteItem("trill", { glyph: "ornamentTrill", small: true, text: "1" }, { value: 2 }),
      ],
    },
    {
      label: "Speed",
      items: TRILL_SPEEDS.map(([value, text]) =>
        noteItem(
          "trillSpeed",
          { mark: text },
          {
            value,
            // The speed is always set (32nd notes by default): it only counts with a trill.
            neutral: true,
            label: `Trill speed: ${choiceLabel(NOTE_EFFECTS.trillSpeed, value)}`,
          },
        ),
      ),
    },
  ],
};

const GRACE_BOX: PaletteBox = {
  id: "grace",
  label: "Grace note",
  columns: 2,
  groups: [
    {
      items: [
        plain(
          "grace:before",
          "Grace note before the beat",
          glyph("graceNoteAcciaccaturaStemUp", SMALL),
          { type: "grace", grace: GraceType.BeforeBeat },
        ),
        plain("grace:on", "Grace note on the beat", glyph("graceNoteAppoggiaturaStemUp", SMALL), {
          type: "grace",
          grace: GraceType.OnBeat,
        }),
      ],
    },
  ],
};

// --- guitar boxes -------------------------------------------------------------------------------

const VIBRATO_BOX: PaletteBox = {
  id: "vibrato",
  label: "Vibrato",
  columns: 2,
  groups: [
    {
      items: [
        noteItem("vibrato", glyph("guitarVibratoStroke", SMALL), {
          value: VibratoType.Slight,
          shortcut: "W",
        }),
        noteItem("vibrato", glyph("guitarWideVibratoStroke", SMALL), { value: VibratoType.Wide }),
      ],
    },
  ],
};

const HARMONIC_MARKS: [number, string, string?][] = [
  [HarmonicType.Natural, "N.H.", "N"],
  [HarmonicType.Artificial, "A.H."],
  [HarmonicType.Pinch, "P.H."],
  [HarmonicType.Tap, "T.H."],
  [HarmonicType.Semi, "S.H."],
];

const HARMONIC_BOX: PaletteBox = {
  id: "harmonic",
  label: "Harmonic",
  columns: 5,
  idle: glyph("noteheadDiamondWhite", SMALL),
  groups: [
    {
      items: HARMONIC_MARKS.map(([value, mark, shortcut]) =>
        noteItem(
          "harmonic",
          value === HarmonicType.Natural ? glyph("noteheadDiamondWhite", SMALL) : { mark },
          { value, shortcut },
        ),
      ),
    },
  ],
};

const slideOut = (value: number, text: string, shortcut?: string) =>
  noteItem("slideOut", { mark: text }, { value, shortcut });
const slideIn = (value: number, text: string) => noteItem("slideIn", { mark: text }, { value });

const SLIDE_BOX: PaletteBox = {
  id: "slide",
  label: "Slide",
  columns: 5,
  idle: { mark: "sl." },
  groups: [
    {
      label: "Slide out",
      items: [
        slideOut(SlideOutType.Shift, "sh.", "S"),
        slideOut(SlideOutType.Legato, "leg."),
        slideOut(SlideOutType.OutDown, "out ↓"),
        slideOut(SlideOutType.OutUp, "out ↑"),
        slideOut(SlideOutType.PickSlideDown, "pick ↓"),
        slideOut(SlideOutType.PickSlideUp, "pick ↑"),
      ],
    },
    {
      label: "Slide in",
      items: [
        slideIn(SlideInType.IntoFromBelow, "in ↑"),
        slideIn(SlideInType.IntoFromAbove, "in ↓"),
      ],
    },
  ],
};

const PICK_STROKE_BOX: PaletteBox = {
  id: "pick",
  label: "Pick stroke",
  columns: 2,
  groups: [
    {
      items: [
        beatItem("pickStroke", glyph("stringsDownBow"), {
          value: PickStroke.Down,
          label: "Downstroke",
        }),
        beatItem("pickStroke", glyph("stringsUpBow"), { value: PickStroke.Up, label: "Upstroke" }),
      ],
    },
  ],
};

const BRUSH_BOX: PaletteBox = {
  id: "brush",
  label: "Brush / arpeggio",
  columns: 4,
  groups: [
    {
      items: [
        beatItem("brush", glyph("guitarStrumDown", SMALL), { value: BrushType.BrushDown }),
        beatItem("brush", glyph("guitarStrumUp", SMALL), { value: BrushType.BrushUp }),
        beatItem("brush", glyph("arpeggiatoDown"), { value: BrushType.ArpeggioDown }),
        beatItem("brush", glyph("arpeggiatoUp"), { value: BrushType.ArpeggioUp }),
      ],
    },
  ],
};

const TREMOLO_BOX: PaletteBox = {
  id: "tremolo",
  label: "Tremolo picking",
  columns: 3,
  idle: glyph("tremolo3"),
  groups: [
    {
      items: [
        beatItem("tremolo", glyph("tremolo1"), { value: 1 }),
        beatItem("tremolo", glyph("tremolo2"), { value: 2 }),
        beatItem("tremolo", glyph("tremolo3"), { value: 3 }),
      ],
    },
  ],
};

const FADE_BOX: PaletteBox = {
  id: "fade",
  label: "Fade",
  columns: 3,
  groups: [
    {
      items: [
        beatItem("fade", glyph("guitarFadeIn", SMALL), { value: FadeType.FadeIn }),
        beatItem("fade", glyph("guitarFadeOut", SMALL), { value: FadeType.FadeOut }),
        beatItem("fade", glyph("guitarVolumeSwell", SMALL), { value: FadeType.VolumeSwell }),
      ],
    },
  ],
};

const WAH_BOX: PaletteBox = {
  id: "wah",
  label: "Wah",
  columns: 2,
  groups: [
    {
      items: [
        beatItem("wah", glyph("guitarOpenPedal"), { value: WahPedal.Open }),
        beatItem("wah", glyph("guitarClosePedal"), { value: WahPedal.Closed }),
      ],
    },
  ],
};

const RASGUEADO_BOX: PaletteBox = {
  id: "rasgueado",
  label: "Rasgueado",
  columns: 6,
  idle: { mark: "rasg." },
  groups: [
    {
      items: BEAT_EFFECTS.rasgueado.choices
        .filter((c) => c.value !== BEAT_EFFECTS.rasgueado.choices[0]!.value)
        .map((c) =>
          beatItem(
            "rasgueado",
            {
              mark: c.label
                .replace(/^Rasgueado /, "")
                .replace(" (triplet)", " t")
                .replace(" (anapaest)", " a"),
            },
            { value: c.value, span: 2 },
          ),
        ),
    },
  ],
};

// --- the palette --------------------------------------------------------------------------------

const DYNAMICS: [number, SmuflName][] = [
  [DynamicValue.PPP, "dynamicPPP"],
  [DynamicValue.PP, "dynamicPP"],
  [DynamicValue.P, "dynamicPiano"],
  [DynamicValue.MP, "dynamicMP"],
  [DynamicValue.MF, "dynamicMF"],
  [DynamicValue.F, "dynamicForte"],
  [DynamicValue.FF, "dynamicFF"],
  [DynamicValue.FFF, "dynamicFFF"],
];

const ACCIDENTALS: [number, SmuflName][] = [
  [NoteAccidentalMode.ForceSharp, "accidentalSharp"],
  [NoteAccidentalMode.ForceFlat, "accidentalFlat"],
  [NoteAccidentalMode.ForceNatural, "accidentalNatural"],
  [NoteAccidentalMode.ForceDoubleSharp, "accidentalDoubleSharp"],
  [NoteAccidentalMode.ForceDoubleFlat, "accidentalDoubleFlat"],
];

const NOTE_GLYPHS: Record<number, SmuflName> = {
  1: "noteWhole",
  2: "noteHalfUp",
  4: "noteQuarterUp",
  8: "note8thUp",
  16: "note16thUp",
  32: "note32ndUp",
  64: "note64thUp",
};

const durationCells = NOTE_VALUES.map(({ duration, label }, i) =>
  cell({
    id: `duration:${duration}`,
    label,
    shortcut: String(i + 1),
    visual: glyph(NOTE_GLYPHS[duration] ?? "noteQuarterUp"),
    action: { type: "duration", duration },
  }),
);

export const PALETTE_SECTIONS: PaletteSection[] = [
  {
    id: "structure",
    label: "Score structure",
    toolbar: "Edit",
    rows: [
      {
        heading: "Bar",
        entries: [
          box(KEY_BOX),
          box(TIME_BOX),
          box(TEMPO_BOX),
          box(FEEL_BOX),
          cell(
            plain("repeat:start", "Repeat start", glyph("repeatLeft"), {
              type: "repeat",
              side: "start",
            }),
          ),
          cell(
            plain("repeat:end", "Repeat end", glyph("repeatRight"), {
              type: "repeat",
              side: "end",
            }),
          ),
          box(ENDINGS_BOX),
          box(JUMPS_BOX),
        ],
      },
      {
        entries: [
          box(OCTAVE_BOX),
          cell(plain("bar", "Bar", { icon: "bar" }, { type: "bar" }, { shortcut: "⌘B" })),
        ],
      },
    ],
  },
  {
    id: "notes",
    label: "Notes and rhythm",
    toolbar: "Edit",
    rows: [
      { heading: "Notes", entries: durationCells, radioLabel: "Note value" },
      {
        heading: "Rhythm",
        entries: [
          cell(
            plain(
              "dots:1",
              "Dot",
              glyph("augmentationDot", DOT),
              { type: "dots", count: 1 },
              { shortcut: "." },
            ),
          ),
          cell(
            plain("dots:2", "Double dot", glyph(["augmentationDot", "augmentationDot"], DOT), {
              type: "dots",
              count: 2,
            }),
          ),
          cell(plain("rest", "Rest", glyph("restQuarter"), { type: "rest" }, { shortcut: "R" })),
          cell(plain("tie", "Tie", { icon: "tie" }, { type: "tie" }, { shortcut: "T" })),
          box(TUPLET_BOX),
          box(VOICE_BOX),
        ],
      },
      {
        heading: "Beats",
        entries: [
          cell(
            plain(
              "fillRests",
              "Fill bar with rests",
              { icon: "fillRests" },
              { type: "fillRests" },
              { shortcut: "Shift+R" },
            ),
          ),
          cell(
            plain(
              "insertBeat",
              "Insert beat",
              { icon: "insertBeat" },
              { type: "insertBeat" },
              { shortcut: "I" },
            ),
          ),
          cell(
            plain(
              "deleteBeat",
              "Delete beat",
              { icon: "deleteBeat" },
              { type: "deleteBeat" },
              { shortcut: "Shift+Delete" },
            ),
          ),
        ],
      },
      {
        heading: "Accidentals",
        entries: ACCIDENTALS.map(([value, name]) =>
          cell(noteItem("accidental", glyph(name), { value })),
        ),
      },
    ],
  },
  {
    id: "marks",
    label: "Dynamics and marks",
    toolbar: "Effects",
    rows: [
      {
        heading: "Dynamics",
        entries: DYNAMICS.map(([value, name]) =>
          cell(beatItem("dynamics", glyph(name), { value })),
        ),
      },
      {
        entries: [
          cell(
            beatItem("crescendo", glyph("dynamicCrescendoHairpin", SMALL), {
              value: CrescendoType.Crescendo,
              label: "Crescendo",
            }),
          ),
          cell(
            beatItem("crescendo", glyph("dynamicDiminuendoHairpin", SMALL), {
              value: CrescendoType.Decrescendo,
              label: "Decrescendo",
            }),
          ),
        ],
      },
      {
        heading: "Marks",
        entries: [
          box(ARTICULATION_BOX),
          cell(plain("fermata", "Fermata", glyph("fermataAbove"), { type: "fermata" })),
          cell(
            noteItem("dead", glyph("noteheadXBlack", "text-2xl"), {
              shortcut: "X",
            }),
          ),
          cell(
            noteItem(
              "ghost",
              glyph(
                ["noteheadParenthesisLeft", "noteheadBlack", "noteheadParenthesisRight"],
                "text-2xl",
              ),
              { shortcut: "O" },
            ),
          ),
          box(TRILL_BOX),
          box(GRACE_BOX),
        ],
      },
    ],
  },
  {
    id: "guitar",
    label: "Guitar",
    toolbar: "Effects",
    rows: [
      {
        heading: "Techniques",
        entries: [
          cell(noteItem("hammerPull", { mark: "H/P" }, { shortcut: "H", mark: "H/P" })),
          cell(noteItem("palmMute", { mark: "P.M." }, { shortcut: "P", mark: "P.M." })),
          cell(noteItem("letRing", { mark: "L.R." }, { shortcut: "L", mark: "L.R." })),
          box(VIBRATO_BOX),
          box(HARMONIC_BOX),
          box(SLIDE_BOX),
          cell(plain("bend", "Bend", { icon: "bend" }, { type: "bend" }, { shortcut: "Shift+B" })),
          cell(plain("whammy", "Whammy", { icon: "whammy" }, { type: "whammy" })),
        ],
      },
      {
        heading: "Picking",
        entries: [
          cell(beatItem("tap", { mark: "T" }, { label: "Tapping", mark: "T" })),
          cell(beatItem("slap", { mark: "S" }, { mark: "S" })),
          cell(beatItem("pop", { mark: "P" }, { mark: "P" })),
          cell(noteItem("leftHandTap", { mark: "LH" }, { mark: "LH" })),
          box(PICK_STROKE_BOX),
          box(BRUSH_BOX),
          box(TREMOLO_BOX),
          box(FADE_BOX),
        ],
      },
      { entries: [box(WAH_BOX), box(RASGUEADO_BOX)] },
    ],
  },
  {
    id: "text",
    label: "Text and help",
    toolbar: "Effects",
    rows: [
      {
        heading: "Text and help",
        entries: [
          cell(plain("chord", "Chord", { icon: "chord" }, { type: "chord" })),
          cell(plain("text", "Text", { icon: "text" }, { type: "text" })),
          cell(plain("lyrics", "Lyrics", { icon: "lyrics" }, { type: "lyrics" })),
          cell(plain("shortcuts", "Shortcuts", { icon: "shortcuts" }, { type: "shortcuts" })),
        ],
      },
    ],
  },
];

// --- queries ------------------------------------------------------------------------------------

/** The kinds of track an action makes sense on (effects follow the catalogue). */
export function actionKinds(action: PaletteAction): readonly TrackKind[] {
  switch (action.type) {
    case "noteEffect":
      return (NOTE_EFFECTS[action.id] as Effect).kinds;
    case "beatEffect":
      return (BEAT_EFFECTS[action.id] as Effect).kinds;
    case "bend":
    case "whammy":
      return ["stringed"];
    case "lyrics":
      return ["stringed", "pitched"];
    default:
      return ["stringed", "pitched", "drums"];
  }
}

export const itemAvailable = (item: PaletteItem, kind: TrackKind) =>
  actionKinds(item.action).includes(kind);

/** The groups of a box that have items on this kind of track (empty: the box is left out). */
export function boxGroups(b: PaletteBox, kind: TrackKind): PaletteGroup[] {
  return b.groups
    .map((g) => ({ ...g, items: g.items.filter((item) => itemAvailable(item, kind)) }))
    .filter((g) => g.items.length > 0);
}

/** Every item of the palette, boxes included (for tests and lookups). */
export function allItems(): PaletteItem[] {
  return PALETTE_SECTIONS.flatMap((s) =>
    s.rows.flatMap((r) =>
      r.entries.flatMap((e) => ("cell" in e ? [e.cell] : e.box.groups.flatMap((g) => g.items))),
    ),
  );
}

/** The sections and rows with what the track kind has: nothing empty is left. */
export function paletteFor(kind: TrackKind): PaletteSection[] {
  return PALETTE_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows
      .map((row) => ({
        ...row,
        entries: row.entries.filter((e) =>
          "cell" in e ? itemAvailable(e.cell, kind) : boxGroups(e.box, kind).length > 0,
        ),
      }))
      .filter((row) => row.entries.length > 0),
  })).filter((section) => section.rows.length > 0);
}
