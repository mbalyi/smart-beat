/**
 * MusicXML export (score-partwise 3.1): one part per track, with pitches,
 * rhythms, ties, tuplets, tab positions (string and fret), tunings, key and
 * time signatures, tempo, repeats, rehearsal marks and lyrics.
 *
 * Techniques that MusicXML has no standard element for (bends, slides, palm
 * mute...) are not exported; Guitar Pro files keep them.
 */
import { model } from "@coderline/alphatab";

import { beatTicks } from "@/lib/score/bar-duration";
import { prefersFlats } from "@/lib/score/keys";
import {
  drumKey,
  type Bar,
  type Beat,
  type MasterBar,
  type Note,
  type Score,
  type Track,
} from "@/lib/score/model";
import { tempoAt } from "@/lib/score/structure";

const { Clef, GraceType } = model;

/** Divisions per quarter note: a multiple of every common note value and tuplet. */
export const DIVISIONS = 960;

const SHARP_STEPS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const SHARP_ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_STEPS = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
const FLAT_ALTERS = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];

const TYPES: Record<number, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "16th",
  32: "32nd",
  64: "64th",
};

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** `<step>`, `<alter>` and `<octave>` for a MIDI pitch. */
function pitchXml(pitch: number, flats: boolean): string {
  const pc = ((pitch % 12) + 12) % 12;
  const step = (flats ? FLAT_STEPS : SHARP_STEPS)[pc]!;
  const alter = (flats ? FLAT_ALTERS : SHARP_ALTERS)[pc]!;
  const octave = Math.floor(pitch / 12) - 1;
  const alterXml = alter !== 0 ? `<alter>${alter}</alter>` : "";
  return `<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch>`;
}

const isGuitarLike = (track: Track) => track.staves[0]!.displayTranspositionPitch === -12;

function clefXml(track: Track, bar: Bar | undefined): string {
  if (track.isPercussion || track.staves[0]!.isPercussion) {
    return "<clef><sign>percussion</sign><line>2</line></clef>";
  }
  const clef = bar?.clef;
  if (clef === Clef.F4) return "<clef><sign>F</sign><line>4</line></clef>";
  if (clef === Clef.C3) return "<clef><sign>C</sign><line>3</line></clef>";
  if (clef === Clef.C4) return "<clef><sign>C</sign><line>4</line></clef>";
  if (isGuitarLike(track)) {
    return "<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>";
  }
  return "<clef><sign>G</sign><line>2</line></clef>";
}

/** `<staff-details>` with the tuning of a stringed track (lines from the bottom string up). */
function staffDetails(track: Track): string {
  const staff = track.staves[0]!;
  const tuning = staff.stringTuning.tunings;
  if (tuning.length === 0 || track.isPercussion) return "";
  const lines = [...tuning].reverse().map((pitch, i) => {
    const pc = ((pitch % 12) + 12) % 12;
    const alter = SHARP_ALTERS[pc]! !== 0 ? "<tuning-alter>1</tuning-alter>" : "";
    return `<staff-tuning line="${i + 1}"><tuning-step>${SHARP_STEPS[pc]}</tuning-step>${alter}<tuning-octave>${Math.floor(pitch / 12) - 1}</tuning-octave></staff-tuning>`;
  });
  const capo = staff.capo > 0 ? `<capo>${staff.capo}</capo>` : "";
  return `<staff-details><staff-lines>${tuning.length}</staff-lines>${lines.join("")}${capo}</staff-details>`;
}

function timeXml(masterBar: MasterBar): string {
  return `<time><beats>${masterBar.timeSignatureNumerator}</beats><beat-type>${masterBar.timeSignatureDenominator}</beat-type></time>`;
}

function keyXml(masterBar: MasterBar): string {
  const mode = masterBar.keySignatureType === 1 ? "minor" : "major";
  return `<key><fifths>${masterBar.keySignature}</fifths><mode>${mode}</mode></key>`;
}

interface Context {
  track: Track;
  flats: boolean;
  /** Drum keys seen, for the part's instrument list. */
  drums: Set<number>;
  partId: string;
}

function noteXml(
  ctx: Context,
  beat: Beat,
  note: Note | null,
  chord: boolean,
  voice: number,
  divisions: number,
): string {
  const grace = beat.graceType !== GraceType.None;
  const parts: string[] = ["<note>"];
  if (grace) parts.push("<grace/>");
  if (chord) parts.push("<chord/>");
  if (note === null) {
    parts.push(beat.isFullBarRest ? '<rest measure="yes"/>' : "<rest/>");
  } else if (note.isPercussion) {
    const key = drumKey(note);
    ctx.drums.add(key);
    parts.push(
      "<unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched>",
    );
  } else {
    // The sounding pitch. Guitars show it with a treble clef an octave down (see `clefXml`).
    parts.push(pitchXml(note.realValueWithoutHarmonic, ctx.flats));
  }
  if (!grace) parts.push(`<duration>${divisions}</duration>`);
  if (note?.isTieDestination) parts.push('<tie type="stop"/>');
  if (note?.isTieOrigin) parts.push('<tie type="start"/>');
  if (note?.isPercussion) parts.push(`<instrument id="${ctx.partId}-I${drumKey(note)}"/>`);
  parts.push(`<voice>${voice}</voice>`);
  const type = TYPES[beat.duration];
  if (type) parts.push(`<type>${type}</type>`);
  for (let i = 0; i < beat.dots; i++) parts.push("<dot/>");
  if (beat.tupletNumerator > 1 || beat.tupletDenominator > 1) {
    parts.push(
      `<time-modification><actual-notes>${beat.tupletNumerator}</actual-notes><normal-notes>${beat.tupletDenominator}</normal-notes></time-modification>`,
    );
  }
  if (note?.isDead) parts.push("<notehead>x</notehead>");
  const notations: string[] = [];
  if (note?.isTieDestination) notations.push('<tied type="stop"/>');
  if (note?.isTieOrigin) notations.push('<tied type="start"/>');
  if (note?.isStringed) {
    // MusicXML counts strings from the highest one; alphaTab from the lowest.
    const strings = ctx.track.staves[0]!.stringTuning.tunings.length;
    const technical = [
      `<string>${strings - note.string + 1}</string>`,
      `<fret>${note.fret}</fret>`,
    ];
    if (note.isHarmonic) technical.push("<harmonic/>");
    notations.push(`<technical>${technical.join("")}</technical>`);
  }
  if (notations.length > 0) parts.push(`<notations>${notations.join("")}</notations>`);
  const lyric = !chord && note !== null ? beat.lyrics?.[0] : null;
  if (lyric) {
    parts.push(
      `<lyric number="1"><syllabic>single</syllabic><text>${escape(lyric)}</text></lyric>`,
    );
  }
  parts.push("</note>");
  return parts.join("");
}

function beatXml(ctx: Context, beat: Beat, voice: number): string {
  const divisions =
    beat.graceType !== GraceType.None ? 0 : Math.max(1, Math.round(beatTicks(beat)));
  const notes = beat.isEmpty ? [] : beat.notes;
  if (notes.length === 0) return noteXml(ctx, beat, null, false, voice, divisions);
  return notes.map((note, i) => noteXml(ctx, beat, note, i > 0, voice, divisions)).join("");
}

function measureXml(
  ctx: Context,
  masterBar: MasterBar,
  index: number,
  previous: MasterBar | null,
  bar: Bar | undefined,
  score: Score,
): string {
  const { track } = ctx;
  const out: string[] = [`<measure number="${index + 1}">`];
  const timeChanged =
    !previous ||
    previous.timeSignatureNumerator !== masterBar.timeSignatureNumerator ||
    previous.timeSignatureDenominator !== masterBar.timeSignatureDenominator;
  const keyChanged =
    !previous ||
    previous.keySignature !== masterBar.keySignature ||
    previous.keySignatureType !== masterBar.keySignatureType;

  if (masterBar.isRepeatStart) {
    out.push('<barline location="left"><repeat direction="forward"/></barline>');
  }
  if (masterBar.alternateEndings !== 0) {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8].filter(
      (n) => masterBar.alternateEndings & (1 << (n - 1)),
    );
    out.push(
      `<barline location="left"><ending number="${numbers.join(",")}" type="start"/></barline>`,
    );
  }

  const attributes: string[] = [];
  if (index === 0) attributes.push(`<divisions>${DIVISIONS}</divisions>`);
  if (keyChanged) attributes.push(keyXml(masterBar));
  if (timeChanged) attributes.push(timeXml(masterBar));
  if (index === 0) {
    attributes.push(clefXml(track, bar));
    const details = staffDetails(track);
    if (details) attributes.push(details);
  }
  if (attributes.length > 0) out.push(`<attributes>${attributes.join("")}</attributes>`);

  const tempo = masterBar.tempoAutomations.find(
    (a) => a.type === model.AutomationType.Tempo && a.ratioPosition === 0,
  );
  if (tempo || index === 0) {
    const bpm = Math.round(tempo ? tempo.value : tempoAt(score, index));
    out.push(
      `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`,
    );
  }
  const section = masterBar.section?.text?.trim();
  if (section) {
    out.push(
      `<direction placement="above"><direction-type><rehearsal>${escape(section)}</rehearsal></direction-type></direction>`,
    );
  }

  const barTicks = Math.round(masterBar.calculateDuration());
  const voices = (bar?.voices ?? []).slice(0, 4);
  let written = 0;
  voices.forEach((voice, v) => {
    const beats = voice.beats;
    const hasMusic = v === 0 || beats.some((b) => !b.isEmpty && b.notes.length > 0);
    if (!hasMusic) return;
    if (written > 0) out.push(`<backup><duration>${barTicks}</duration></backup>`);
    if (beats.length === 0 || beats.every((b) => b.isEmpty)) {
      out.push(
        `<note><rest measure="yes"/><duration>${barTicks}</duration><voice>${v + 1}</voice></note>`,
      );
    } else {
      for (const beat of beats) out.push(beatXml(ctx, beat, v + 1));
    }
    written++;
  });
  if (written === 0) {
    out.push(`<note><rest measure="yes"/><duration>${barTicks}</duration><voice>1</voice></note>`);
  }

  if (masterBar.alternateEndings !== 0) {
    const numbers = [1, 2, 3, 4, 5, 6, 7, 8].filter(
      (n) => masterBar.alternateEndings & (1 << (n - 1)),
    );
    const closes = masterBar.repeatCount > 0;
    out.push(
      `<barline location="right"><ending number="${numbers.join(",")}" type="${closes ? "stop" : "discontinue"}"/>${
        closes ? `<repeat direction="backward" times="${masterBar.repeatCount}"/>` : ""
      }</barline>`,
    );
  } else if (masterBar.repeatCount > 0) {
    out.push(
      `<barline location="right"><repeat direction="backward" times="${masterBar.repeatCount}"/></barline>`,
    );
  } else if (masterBar.isDoubleBar) {
    out.push('<barline location="right"><bar-style>light-light</bar-style></barline>');
  }
  out.push("</measure>");
  return out.join("");
}

/** Writes `score` as an uncompressed MusicXML document. */
export function writeMusicXml(score: Score): string {
  const partList: string[] = [];
  const parts: string[] = [];
  score.tracks.forEach((track, index) => {
    const partId = `P${index + 1}`;
    const staff = track.staves[0]!;
    const firstBar = staff.bars[0];
    const key = score.masterBars[0]?.keySignature ?? 0;
    const ctx: Context = {
      track,
      flats: prefersFlats(firstBar?.keySignature ?? key),
      drums: new Set(),
      partId,
    };
    const measures = score.masterBars.map((masterBar, barIndex) =>
      measureXml(
        ctx,
        masterBar,
        barIndex,
        score.masterBars[barIndex - 1] ?? null,
        staff.bars[barIndex],
        score,
      ),
    );
    const name = track.name.trim() || `Track ${index + 1}`;
    const info = track.playbackInfo;
    const channel = track.isPercussion ? 10 : Math.min(15, Math.max(0, info.primaryChannel)) + 1;
    const instruments = track.isPercussion
      ? [...ctx.drums]
          .map(
            (keyNumber) =>
              `<score-instrument id="${partId}-I${keyNumber}"><instrument-name>Drum ${keyNumber}</instrument-name></score-instrument>`,
          )
          .join("")
      : `<score-instrument id="${partId}-I1"><instrument-name>${escape(name)}</instrument-name></score-instrument>`;
    const midi = track.isPercussion
      ? [...ctx.drums]
          .map(
            (keyNumber) =>
              `<midi-instrument id="${partId}-I${keyNumber}"><midi-channel>10</midi-channel><midi-unpitched>${keyNumber + 1}</midi-unpitched></midi-instrument>`,
          )
          .join("")
      : `<midi-instrument id="${partId}-I1"><midi-channel>${channel}</midi-channel><midi-program>${info.program + 1}</midi-program></midi-instrument>`;
    partList.push(
      `<score-part id="${partId}"><part-name>${escape(name)}</part-name>${instruments}${midi}</score-part>`,
    );
    parts.push(`<part id="${partId}">${measures.join("")}</part>`);
  });

  const creator = score.artist.trim()
    ? `<identification><creator type="composer">${escape(score.artist.trim())}</creator><encoding><software>Smart Beat</software></encoding></identification>`
    : "<identification><encoding><software>Smart Beat</software></encoding></identification>";
  const title = score.title.trim()
    ? `<work><work-title>${escape(score.title.trim())}</work-title></work>`
    : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="3.1">',
    title,
    creator,
    `<part-list>${partList.join("")}</part-list>`,
    ...parts,
    "</score-partwise>",
    "",
  ].join("\n");
}
