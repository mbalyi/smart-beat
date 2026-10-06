/**
 * MuseScore export (`.mscx`, and `.mscz`, which is a ZIP holding one): the
 * mirror of `src/lib/import/musescore.ts`. Written from the file format only
 * (an XML document of parts, staves and measures, as MuseScore 3 writes it and
 * MuseScore 3 and 4 read it), with no MuseScore code or assets (GPL-3.0).
 *
 * Saved: parts with their sound and mix, up to four voices, notes, chords,
 * rests, dots, tuplets, ties, dynamics, the first verse of lyrics, repeats,
 * time and key signatures, and tempo. Left out, and listed in the warnings:
 * everything Guitar Pro has that MuseScore files here do not carry (bends,
 * slides, palm mute…), grace notes, endings, jumps, text, chord diagrams and
 * section names. Staves are standard notation; the strings of a guitar are kept
 * in the instrument, so a tablature staff can be added in MuseScore.
 */
import { model } from "@coderline/alphatab";

import { beatTicks } from "@/lib/score/bar-duration";
import { prefersFlats } from "@/lib/score/keys";
import {
  soundOf,
  type Beat,
  type MasterBar,
  type Note,
  type Score,
  type Track,
} from "@/lib/score/model";
import { tempoAt } from "@/lib/score/structure";
import { writeZip } from "@/lib/export/zip";

const { AutomationType, DynamicValue, GraceType, HarmonicType, SlideInType, SlideOutType } = model;

export interface MuseScoreResult {
  xml: string;
  /** What could not be saved, in words for the user. */
  warnings: string[];
}

/** Voices a MuseScore staff is written with. */
const MAX_VOICES = 4;

/** Ticks of a whole note in the model (see `durationTicks`): 960 per quarter. */
const WHOLE_TICKS = 3840;

const DURATION_NAMES: Record<number, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "16th",
  32: "32nd",
  64: "64th",
};

const DYNAMIC_NAMES = new Map<number, string>([
  [DynamicValue.PPP, "ppp"],
  [DynamicValue.PP, "pp"],
  [DynamicValue.P, "p"],
  [DynamicValue.MP, "mp"],
  [DynamicValue.MF, "mf"],
  [DynamicValue.F, "f"],
  [DynamicValue.FF, "ff"],
  [DynamicValue.FFF, "fff"],
]);

/** Tonal pitch class of each pitch class (C = 14, a step of a fifth is ±1), spelled with sharps or flats. */
const SHARP_TPC = [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19];
const FLAT_TPC = [14, 9, 16, 11, 18, 13, 8, 15, 10, 17, 12, 19];

// --- A small XML builder -------------------------------------------------------------------

interface Element {
  tag: string;
  attrs?: Record<string, string | number>;
  /** Text, or child elements. */
  content?: string | Element[];
}

/** Characters XML 1.0 cannot hold are dropped; the rest is escaped. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const escapeXml = (text: string) =>
  text
    .replace(FORBIDDEN, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const el = (tag: string, content?: string | Element[], attrs?: Element["attrs"]): Element => ({
  tag,
  attrs,
  content,
});
const text = (tag: string, value: string | number): Element => el(tag, String(value));

function render(element: Element, depth: number, out: string[]) {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(element.attrs ?? {})
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join("");
  const { content } = element;
  if (content === undefined || (Array.isArray(content) && content.length === 0)) {
    out.push(`${pad}<${element.tag}${attrs}/>`);
  } else if (typeof content === "string") {
    out.push(`${pad}<${element.tag}${attrs}>${escapeXml(content)}</${element.tag}>`);
  } else {
    out.push(`${pad}<${element.tag}${attrs}>`);
    for (const child of content) render(child, depth + 1, out);
    out.push(`${pad}</${element.tag}>`);
  }
}

// --- Helpers -------------------------------------------------------------------------------

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** A length in ticks as a fraction of a whole note: "3/8". */
function fraction(ticks: number): string {
  const divisor = gcd(Math.abs(ticks), WHOLE_TICKS) || 1;
  return `${ticks / divisor}/${WHOLE_TICKS / divisor}`;
}

const trackLabel = (track: Track) => track.name.trim() || `Track ${track.index + 1}`;

/** Whether a beat is more than one note long in a tuplet (a ratio other than 1:1). */
const inTuplet = (beat: Beat) =>
  beat.tupletNumerator > 1 &&
  beat.tupletDenominator > 0 &&
  beat.tupletNumerator !== beat.tupletDenominator;

/** The beats a voice writes: grace notes have no place in the file. */
const writtenBeats = (beats: readonly Beat[]) =>
  beats.filter((b) => b.graceType === GraceType.None);

/** Whether voice `index` of a bar holds music (voices after the first are skipped when empty). */
const hasMusic = (beats: readonly Beat[], index: number) =>
  index === 0 ? beats.length > 0 : beats.some((beat) => !beat.isEmpty);

/** The techniques a note or beat has that these files do not carry. */
function techniques(note: Note): string[] {
  const found: string[] = [];
  if (note.bendPoints && note.bendPoints.length > 0) found.push("bends");
  if (note.slideOutType !== SlideOutType.None || note.slideInType !== SlideInType.None)
    found.push("slides");
  if (note.isHammerPullOrigin) found.push("hammer-ons and pull-offs");
  if (note.isPalmMute) found.push("palm mute");
  if (note.isLetRing) found.push("let ring");
  if (note.harmonicType !== HarmonicType.None) found.push("harmonics");
  if (note.vibrato !== model.VibratoType.None) found.push("vibrato");
  if (note.isStaccato) found.push("staccato");
  if (note.accentuated !== model.AccentuationType.None) found.push("accents");
  if (note.isGhost) found.push("ghost notes");
  if (note.isDead) found.push("dead notes");
  if (note.isTrill) found.push("trills");
  return found;
}

function beatTechniques(beat: Beat): string[] {
  const found: string[] = [];
  if (beat.tremoloPicking) found.push("tremolo picking");
  if (beat.brushType !== model.BrushType.None) found.push("brushes");
  if (beat.tap || beat.slap || beat.pop) found.push("tap, slap and pop");
  if (beat.whammyBarPoints && beat.whammyBarPoints.length > 0) found.push("whammy bar");
  if (beat.vibrato !== model.VibratoType.None) found.push("vibrato");
  return found;
}

// --- The writer ----------------------------------------------------------------------------

interface VoiceState {
  /** The dynamic in effect (written again only when it changes). */
  dynamic: number;
  /** Ticks of the chord or rest before the current one (how far back a tie started). */
  previousTicks: number;
  /** The tuplet being written: its id and how many of its notes are still to come. */
  tuplet: { id: number; remaining: number } | null;
  /** The last lyric syllable ended with a hyphen: the next one continues the word. */
  midWord: boolean;
}

class MuseScoreWriter {
  private readonly warnings = new Set<string>();
  private nextTuplet = 1;

  private readonly score: Score;

  constructor(score: Score) {
    this.score = score;
  }

  write(): MuseScoreResult {
    const { score } = this;
    this.checkWhatIsLeftOut();
    const parts = score.tracks.map((track, i) => this.part(track, i));
    const staves = score.tracks.map((track, i) => this.staff(track, i));
    const tags = [
      ["workTitle", score.title],
      ["composer", score.artist || score.music],
      ["lyricist", score.words],
      ["copyright", score.copyright],
    ]
      .filter((entry): entry is [string, string] => !!entry[1])
      .map(([name, value]) => el("metaTag", value, { name }));
    const root = el(
      "museScore",
      [el("Score", [text("Division", 480), ...tags, ...parts, ...staves])],
      { version: "3.02" },
    );
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
    render(root, 0, lines);
    return { xml: `${lines.join("\n")}\n`, warnings: [...this.warnings] };
  }

  /** The warnings about whole kinds of content, found by looking through the score once. */
  private checkWhatIsLeftOut() {
    const { score, warnings } = this;
    const lost = new Set<string>();
    let grace = false;
    let tooShort = false;
    let hasText = false;
    let voices = false;
    for (const track of score.tracks) {
      const staff = track.staves[0];
      for (const bar of staff?.bars ?? []) {
        voices ||= bar.voices
          .slice(MAX_VOICES)
          .some((voice) => voice.beats.some((b) => !b.isEmpty));
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.graceType !== GraceType.None) grace = true;
            if (beat.duration > 64) tooShort = true;
            if (beat.text || beat.chordId) hasText = true;
            for (const found of beatTechniques(beat)) lost.add(found);
            for (const note of beat.notes) for (const found of techniques(note)) lost.add(found);
          }
        }
      }
      if (staff && !staff.isPercussion && staff.stringTuning.tunings.length > 0) {
        warnings.add(
          "Tablature is saved as standard notation (the strings stay in the instrument): add a tablature staff in MuseScore.",
        );
      }
    }
    if (lost.size > 0) warnings.add(`These are left out: ${[...lost].join(", ")}.`);
    if (grace) warnings.add("Grace notes are left out.");
    if (tooShort) warnings.add("Notes shorter than a 64th are saved as 64ths.");
    if (voices) warnings.add(`Only the first ${MAX_VOICES} voices of each staff are saved.`);
    if (score.masterBars.some((m) => m.alternateEndings !== 0)) {
      warnings.add("Volta endings (1st and 2nd time bars) are left out.");
    }
    if (score.masterBars.some((m) => (m.directions?.size ?? 0) > 0)) {
      warnings.add("Jumps (Coda, Segno, D.C., D.S.) are left out.");
    }
    if (hasText || score.masterBars.some((m) => m.section?.text)) {
      warnings.add("Text, chord diagrams and section names are left out.");
    }
  }

  private part(track: Track, index: number): Element {
    const staff = track.staves[0]!;
    const info = track.playbackInfo;
    const name = trackLabel(track);
    const drums = track.isPercussion || staff.isPercussion;
    const tuning = staff.stringTuning.tunings;
    const channel = [
      el("program", undefined, { value: drums ? 0 : info.program }),
      el("controller", undefined, { ctrl: 7, value: Math.round((info.volume / 16) * 127) }),
      el("controller", undefined, { ctrl: 10, value: Math.round((info.balance / 16) * 127) }),
      ...(info.isMute ? [text("mute", 1)] : []),
    ];
    const instrument = [
      text("longName", name),
      text("trackName", name),
      ...(drums ? [text("useDrumset", 1)] : []),
      // MuseScore lists the strings from the lowest; Smart Beat from the highest.
      ...(!drums && tuning.length > 0
        ? [
            el("StringData", [
              text("frets", 24),
              ...[...tuning].reverse().map((pitch) => text("string", pitch)),
            ]),
          ]
        : []),
      el("Channel", channel),
    ];
    const staffType = drums
      ? el("StaffType", [text("name", "perc5Line")], { group: "percussion" })
      : el("StaffType", [text("name", "stdNormal")], { group: "pitched" });
    return el("Part", [
      el("Staff", [staffType], { id: index + 1 }),
      text("trackName", name),
      el("Instrument", instrument),
    ]);
  }

  private staff(track: Track, index: number): Element {
    const { score } = this;
    const staff = track.staves[0]!;
    const drums = track.isPercussion || staff.isPercussion;
    const states: VoiceState[] = Array.from({ length: MAX_VOICES }, () => ({
      dynamic: DynamicValue.F,
      previousTicks: 0,
      tuplet: null,
      midWord: false,
    }));
    const measures = score.masterBars.map((masterBar, barIndex) => {
      const bar = staff.bars[barIndex];
      const previous = score.masterBars[barIndex - 1];
      const voices: Element[] = [];
      const written = (bar?.voices ?? [])
        .slice(0, MAX_VOICES)
        .map((voice) => writtenBeats(voice.beats));
      written.forEach((beats, v) => {
        const items: Element[] = [];
        if (v === 0) items.push(...this.barHead(masterBar, previous, index === 0, beats));
        if (hasMusic(beats, v)) {
          items.push(...this.beats(beats, v, states[v]!, masterBar, drums, index === 0));
        } else if (v === 0) {
          items.push(this.measureRest(masterBar));
        }
        voices.push(el("voice", items));
      });
      // Voices after the last one with music are not written; a bar without any voice gets a rest.
      while (voices.length > 1 && voices.at(-1)!.content?.length === 0) voices.pop();
      if (voices.length === 0) {
        const head = this.barHead(masterBar, previous, index === 0, []);
        voices.push(el("voice", [...head, this.measureRest(masterBar)]));
      }
      const marks: Element[] = [];
      if (masterBar.isRepeatStart) marks.push(el("startRepeat"));
      if (masterBar.repeatCount > 0)
        marks.push(text("endRepeat", Math.max(2, masterBar.repeatCount)));
      return el("Measure", [...marks, ...voices]);
    });
    return el("Staff", measures, { id: index + 1 });
  }

  /** A rest that fills the bar. */
  private measureRest(masterBar: MasterBar): Element {
    return el("Rest", [
      text("durationType", "measure"),
      text("duration", `${masterBar.timeSignatureNumerator}/${masterBar.timeSignatureDenominator}`),
    ]);
  }

  /** What a staff's first voice starts a bar with: key and time signature, and (on the first staff) the tempo. */
  private barHead(
    masterBar: MasterBar,
    previous: MasterBar | undefined,
    firstStaff: boolean,
    beats: readonly Beat[],
  ): Element[] {
    const items: Element[] = [];
    if (!previous || previous.keySignature !== masterBar.keySignature) {
      items.push(el("KeySig", [text("accidental", masterBar.keySignature)]));
    }
    if (
      !previous ||
      previous.timeSignatureNumerator !== masterBar.timeSignatureNumerator ||
      previous.timeSignatureDenominator !== masterBar.timeSignatureDenominator
    ) {
      items.push(
        el("TimeSig", [
          text("sigN", masterBar.timeSignatureNumerator),
          text("sigD", masterBar.timeSignatureDenominator),
        ]),
      );
    }
    if (firstStaff) {
      const at = this.tempoMarks(masterBar, beats).get(0);
      if (at !== undefined) items.push(this.tempo(at));
    }
    return items;
  }

  /**
   * The tempo changes of a bar by the index of the beat they start on
   * (beat 0 = the bar's start). The song's first tempo is always written, and
   * a change at the start of a bar only when the tempo differs from before.
   */
  private tempoMarks(masterBar: MasterBar, beats: readonly Beat[]): Map<number, number> {
    const { score } = this;
    const marks = new Map<number, number>();
    const index = masterBar.index;
    const start = tempoAt(score, index);
    if (index === 0 || start !== tempoAt(score, index - 1)) marks.set(0, start);
    const changes = masterBar.tempoAutomations
      .filter((a) => a.type === AutomationType.Tempo && a.ratioPosition > 0)
      .sort((a, b) => a.ratioPosition - b.ratioPosition);
    const barTicks = masterBar.calculateDuration();
    for (const change of changes) {
      const target = change.ratioPosition * barTicks + 0.5;
      let position = 0;
      let chosen = 0;
      beats.forEach((beat, i) => {
        if (position <= target) chosen = i;
        position += beatTicks(beat);
      });
      marks.set(chosen, change.value);
    }
    return marks;
  }

  /** MuseScore stores the tempo in quarter notes per second. */
  private tempo(bpm: number): Element {
    return el("Tempo", [text("tempo", bpm / 60), text("text", `\u2669 = ${bpm}`)]);
  }

  private beats(
    beats: readonly Beat[],
    voice: number,
    state: VoiceState,
    masterBar: MasterBar,
    drums: boolean,
    firstStaff: boolean,
  ): Element[] {
    const items: Element[] = [];
    const flats = prefersFlats(masterBar.keySignature);
    const tempoMarks = voice === 0 && firstStaff ? this.tempoMarks(masterBar, beats) : new Map();
    const barTicks = beats.reduce((sum, beat) => sum + beatTicks(beat), 0);
    const wholeBarRest =
      beats.length === 1 && (beats[0]!.isEmpty || beats[0]!.notes.length === 0) && barTicks > 0;
    if (wholeBarRest && barTicks === masterBar.calculateDuration()) {
      return [this.measureRest(masterBar)];
    }
    beats.forEach((beat, i) => {
      // Tempo changes inside the bar sit before the beat they start on (the one at the start is in the bar head).
      const bpm = tempoMarks.get(i);
      if (bpm !== undefined && i > 0) items.push(this.tempo(bpm));

      const name = DURATION_NAMES[Math.min(beat.duration, 64)] ?? "quarter";
      const ticks = beatTicks(beat);
      const rest = beat.isEmpty || beat.notes.length === 0;
      const body: Element[] = [];
      if (beat.dots > 0) body.push(text("dots", Math.min(beat.dots, 3)));
      body.push(text("durationType", name));

      if (inTuplet(beat)) {
        if (!state.tuplet || state.tuplet.remaining === 0) {
          const id = this.nextTuplet++;
          state.tuplet = { id, remaining: beat.tupletNumerator };
          items.push(
            el(
              "Tuplet",
              [
                text("normalNotes", beat.tupletDenominator),
                text("actualNotes", beat.tupletNumerator),
                text("baseNote", name),
                el("Number", [text("style", "Tuplet"), text("text", beat.tupletNumerator)]),
              ],
              { id },
            ),
          );
        }
        body.push(text("Tuplet", state.tuplet.id));
        state.tuplet.remaining--;
      }

      if (rest) {
        items.push(el("Rest", body));
        state.previousTicks = ticks;
        return;
      }

      const dynamic = DYNAMIC_NAMES.get(beat.dynamics);
      if (dynamic && beat.dynamics !== state.dynamic) {
        items.push(el("Dynamic", [text("subtype", dynamic)]));
        state.dynamic = beat.dynamics;
      }
      // The first verse of the lyrics sits on the notes of the first voice.
      const syllable = voice === 0 ? beat.lyrics?.[0] : undefined;
      if (syllable) body.push(this.lyric(syllable, state));
      for (const note of beat.notes) body.push(this.note(note, drums, flats, ticks, state));
      items.push(el("Chord", body));
      state.previousTicks = ticks;
    });
    return items;
  }

  private lyric(syllable: string, state: VoiceState): Element {
    // alphaTab ends a syllable that continues into the next one with a hyphen.
    const continues = syllable.endsWith("-");
    const word = continues ? syllable.slice(0, -1) : syllable;
    const syllabic = continues
      ? state.midWord
        ? "middle"
        : "begin"
      : state.midWord
        ? "end"
        : null;
    state.midWord = continues;
    return el("Lyrics", [...(syllabic ? [text("syllabic", syllabic)] : []), text("text", word)]);
  }

  private note(
    note: Note,
    drums: boolean,
    flats: boolean,
    ticks: number,
    state: VoiceState,
  ): Element {
    const pitch = Math.max(0, Math.min(127, soundOf(note)));
    const tpc = drums ? 14 : (flats ? FLAT_TPC : SHARP_TPC)[pitch % 12]!;
    const body: Element[] = [];
    // Ties are spanners that say where the other end is: this note's length forward, the previous one's back.
    if (note.isTieOrigin) {
      body.push(
        el(
          "Spanner",
          [el("Tie"), el("next", [el("location", [text("fractions", fraction(ticks))])])],
          {
            type: "Tie",
          },
        ),
      );
    }
    if (note.isTieDestination) {
      body.push(
        el(
          "Spanner",
          [el("prev", [el("location", [text("fractions", fraction(-state.previousTicks))])])],
          { type: "Tie" },
        ),
      );
    }
    body.push(text("pitch", pitch), text("tpc", tpc));
    if (note.isStringed && !drums && note.beat.voice.bar.staff.capo === 0) {
      const strings = note.beat.voice.bar.staff.stringTuning.tunings.length;
      // MuseScore counts the strings from the highest, which is 0.
      body.push(text("string", strings - note.string), text("fret", note.fret));
    }
    return el("Note", body);
  }
}

/** The XML of a MuseScore file (`.mscx`) for `score`. */
export function writeMuseScoreXml(score: Score): MuseScoreResult {
  return new MuseScoreWriter(score).write();
}

/** A `.mscx` file: the XML as UTF-8 bytes. */
export function writeMscx(score: Score): { bytes: Uint8Array; warnings: string[] } {
  const { xml, warnings } = writeMuseScoreXml(score);
  return { bytes: new TextEncoder().encode(xml), warnings };
}

const SCORE_ENTRY = "score.mscx";

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="${SCORE_ENTRY}"/>
  </rootfiles>
</container>
`;

/** A `.mscz` file: a ZIP with the container description and the `.mscx`. */
export function writeMscz(score: Score): { bytes: Uint8Array; warnings: string[] } {
  const { xml, warnings } = writeMuseScoreXml(score);
  const encoder = new TextEncoder();
  const bytes = writeZip([
    { name: "META-INF/container.xml", data: encoder.encode(CONTAINER) },
    { name: SCORE_ENTRY, data: encoder.encode(xml) },
  ]);
  return { bytes, warnings };
}
