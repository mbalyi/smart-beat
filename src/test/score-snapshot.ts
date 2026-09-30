/**
 * A plain-data view of a score's music, for comparing two scores (round trips
 * through file formats). It holds what a musician would call "the same song":
 * bars, rhythms, notes and the main effects, but not alphaTab's internal ids.
 */
import type { Beat, Note, Score } from "@/lib/score/model";
import { drumKey } from "@/lib/score/model";
import { tempoAt } from "@/lib/score/structure";

export interface NoteShot {
  /** `string/fret` for tab notes, the MIDI pitch otherwise, `drum:key` for drums. */
  at: string;
  tie?: true;
  dead?: true;
  ghost?: true;
  accent?: number;
  letRing?: true;
  palmMute?: true;
  staccato?: true;
  hammer?: true;
  vibrato?: number;
  slideOut?: number;
  harmonic?: number;
  bend?: string;
}

export interface BeatShot {
  duration: number;
  dots: number;
  tuplet?: string;
  rest: boolean;
  text?: string;
  notes: NoteShot[];
}

export interface Shot {
  title: string;
  artist: string;
  tracks: {
    name: string;
    percussion: boolean;
    program: number;
    tuning: number[];
    capo: number;
    bars: { voices: BeatShot[][] }[];
  }[];
  bars: {
    time: string;
    key: number;
    repeatStart: boolean;
    repeatCount: number;
    section: string;
    tempo: number;
    endings: number;
  }[];
}

function noteShot(note: Note, pitchOnly: boolean): NoteShot {
  const at = note.isPercussion
    ? `drum:${drumKey(note)}`
    : note.isStringed && !pitchOnly
      ? `${note.string}/${note.fret}`
      : `${note.realValueWithoutHarmonic}`;
  const shot: NoteShot = { at };
  if (note.isTieDestination) shot.tie = true;
  if (note.isDead) shot.dead = true;
  if (note.isGhost) shot.ghost = true;
  if (note.accentuated) shot.accent = note.accentuated;
  if (note.isLetRing) shot.letRing = true;
  if (note.isPalmMute) shot.palmMute = true;
  if (note.isStaccato) shot.staccato = true;
  if (note.isHammerPullOrigin) shot.hammer = true;
  if (note.vibrato) shot.vibrato = note.vibrato;
  if (note.slideOutType) shot.slideOut = note.slideOutType;
  if (note.harmonicType) shot.harmonic = note.harmonicType;
  if (note.bendPoints?.length)
    shot.bend = note.bendPoints.map((p) => `${p.offset}:${p.value}`).join(",");
  return shot;
}

function beatShot(beat: Beat, pitchOnly: boolean): BeatShot {
  const shot: BeatShot = {
    duration: beat.duration,
    dots: beat.dots,
    rest: beat.isRest || beat.isEmpty,
    notes: beat.notes.map((n) => noteShot(n, pitchOnly)).sort((a, b) => a.at.localeCompare(b.at)),
  };
  if (beat.tupletNumerator > 1 || beat.tupletDenominator > 1) {
    shot.tuplet = `${beat.tupletNumerator}:${beat.tupletDenominator}`;
  }
  if (beat.text) shot.text = beat.text;
  return shot;
}

/**
 * `pitchOnly`: tracks (by index) compared by the pitches of their notes, not
 * their strings and frets (for formats that have no strings).
 */
export function shotOf(score: Score, { pitchOnly = [] as number[] } = {}): Shot {
  return {
    title: score.title,
    artist: score.artist,
    tracks: score.tracks.map((track, trackIndex) => {
      const staff = track.staves[0]!;
      const pitches = pitchOnly.includes(trackIndex);
      return {
        name: track.name,
        percussion: track.isPercussion || staff.isPercussion,
        program: track.playbackInfo.program,
        tuning: pitches ? [] : [...staff.stringTuning.tunings],
        capo: staff.capo,
        bars: staff.bars.map((bar) => ({
          voices: bar.voices
            .map((voice) =>
              voice.beats.filter((b) => b.graceType === 0).map((b) => beatShot(b, pitches)),
            )
            .filter((beats) => beats.some((b) => !b.rest)),
        })),
      };
    }),
    bars: score.masterBars.map((masterBar, index) => ({
      time: `${masterBar.timeSignatureNumerator}/${masterBar.timeSignatureDenominator}`,
      key: masterBar.keySignature,
      repeatStart: masterBar.isRepeatStart,
      repeatCount: masterBar.repeatCount,
      section: masterBar.section?.text ?? "",
      tempo: tempoAt(score, index),
      endings: masterBar.alternateEndings,
    })),
  };
}
