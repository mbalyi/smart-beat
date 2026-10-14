/**
 * Standard MIDI file import.
 *
 * A MIDI file has sounds, not notation, so the import makes choices: every
 * MIDI channel that plays notes becomes a track (drums on channel 10), time
 * signatures and tempo changes become bars, and notes are snapped to a grid of
 * sixteenth notes. When the notes do not follow the file's tempo (a recording or an
 * audio conversion), the real tempo and bar lines are found first (see `midi-grid`). Guitar and bass sounds are written as tablature in standard
 * tuning; everything else as a staff. What is lost (triplets, dynamics, notes
 * longer than their gap) is listed in the warnings.
 */
import { importer, model, Settings } from "@coderline/alphatab";

import { placeFrets, type PlacedGroup } from "@/lib/import/fret-placement";
import { findGrid, fitsGrid, gridError } from "@/lib/import/midi-grid";
import { fillDurations } from "@/lib/score/bar-duration";
import { ScoreLoadError } from "@/lib/score/errors";
import { newBeat, placeholderBeats, refinish, type Score, type Track } from "@/lib/score/model";
import {
  durationTicks,
  lowestPitch,
  pitchName,
  QUARTER_TICKS,
  STANDARD_GUITAR,
  type Duration,
} from "@/lib/score/music";
import { rememberMix } from "@/lib/score/score";
import {
  createTrack,
  insertTrack,
  removeTrack,
  uniqueTrackName,
  type NewTrack,
} from "@/lib/score/tracks";

const { Automation, Duration: D } = model;

/** Bass guitar tuning, highest string first. */
const STANDARD_BASS = [43, 38, 33, 28];

/** Sixteenth notes: what onsets are snapped to, in quarter ticks. */
const GRID = QUARTER_TICKS / 4;

/** Safety limits for files from anywhere. */
const MAX_BARS = 2000;
const MAX_NOTES = 500_000;

export interface MidiImport {
  score: Score;
  warnings: string[];
}

export interface RawNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
}

export interface Part {
  trackName: string;
  /** Strings of a guitar part, highest first. Set for recordings; files get a tuning from the sound. */
  tuning?: number[];
  channel: number;
  program: number;
  volume: number | null;
  pan: number | null;
  /** Written in bass clef: the left hand of a piano recording. */
  bass?: boolean;
  notes: RawNote[];
}

// --- Reading the file -----------------------------------------------------------------

class Reader {
  pos = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get done() {
    return this.pos >= this.data.length;
  }

  u8(): number {
    if (this.pos >= this.data.length) throw new ScoreLoadError("The MIDI file is cut off.");
    return this.data[this.pos++]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }

  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new ScoreLoadError("The MIDI file has an invalid time value.");
  }

  bytes(count: number): Uint8Array {
    if (this.pos + count > this.data.length) throw new ScoreLoadError("The MIDI file is cut off.");
    const slice = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }
}

export interface Parsed {
  division: number;
  tempos: { tick: number; bpm: number }[];
  timeSignatures: { tick: number; numerator: number; denominator: number }[];
  keySignature: { fifths: number; minor: boolean } | null;
  parts: Part[];
  endTick: number;
}

export function parse(bytes: Uint8Array): Parsed {
  const reader = new Reader(bytes);
  if (reader.u32() !== 0x4d546864) throw new ScoreLoadError("This is not a MIDI file.");
  const headerLength = reader.u32();
  const header = new Reader(reader.bytes(headerLength));
  header.u16(); // format: 0 and 1 read the same way
  const trackCount = header.u16();
  const division = header.u16();
  if (division & 0x8000) {
    throw new ScoreLoadError("MIDI files timed in SMPTE frames are not supported.");
  }
  if (division === 0) throw new ScoreLoadError("The MIDI file has no time resolution.");

  const scale = QUARTER_TICKS / division;
  const tempos: Parsed["tempos"] = [];
  const timeSignatures: Parsed["timeSignatures"] = [];
  let keySignature: Parsed["keySignature"] = null;
  const parts = new Map<string, Part>();
  let endTick = 0;
  let noteCount = 0;

  for (let t = 0; t < trackCount && !reader.done; t++) {
    const id = reader.u32();
    const length = reader.u32();
    const chunk = new Reader(reader.bytes(Math.min(length, bytes.length - reader.pos)));
    if (id !== 0x4d54726b) continue; // not a track: skip unknown chunks
    let tick = 0;
    let status = 0;
    let trackName = "";
    const open = new Map<string, { start: number; velocity: number }[]>();
    const program = new Map<number, number>();
    const volume = new Map<number, number>();
    const pan = new Map<number, number>();
    const trackParts = new Map<number, Part>();

    const partFor = (channel: number): Part => {
      let part = trackParts.get(channel);
      if (!part) {
        part = {
          trackName,
          channel,
          program: program.get(channel) ?? 0,
          volume: volume.get(channel) ?? null,
          pan: pan.get(channel) ?? null,
          notes: [],
        };
        trackParts.set(channel, part);
        parts.set(`${t}:${channel}`, part);
      }
      return part;
    };

    const closeNote = (channel: number, pitch: number) => {
      const key = `${channel}:${pitch}`;
      const starts = open.get(key);
      const started = starts?.shift();
      if (!started) return;
      const part = partFor(channel);
      const start = Math.round(started.start * scale);
      const end = Math.max(start + 1, Math.round(tick * scale));
      part.notes.push({ start, end, pitch, velocity: started.velocity });
      endTick = Math.max(endTick, end);
      if (++noteCount > MAX_NOTES) throw new ScoreLoadError("The MIDI file has too many notes.");
    };

    try {
      while (!chunk.done) {
        tick += chunk.vlq();
        let first = chunk.u8();
        if (first < 0x80) {
          // Running status: the byte is the first data byte of the last command.
          chunk.pos--;
          first = status;
        } else if (first < 0xf0) {
          status = first;
        }
        if (first === 0xff) {
          const type = chunk.u8();
          const data = chunk.bytes(chunk.vlq());
          if (type === 0x51 && data.length === 3) {
            const micros = (data[0]! << 16) | (data[1]! << 8) | data[2]!;
            if (micros > 0) {
              tempos.push({ tick: Math.round(tick * scale), bpm: 60_000_000 / micros });
            }
          } else if (type === 0x58 && data.length >= 2) {
            timeSignatures.push({
              tick: Math.round(tick * scale),
              numerator: data[0]!,
              denominator: 2 ** data[1]!,
            });
          } else if (type === 0x59 && data.length >= 2 && !keySignature) {
            const fifths = (data[0]! << 24) >> 24;
            keySignature = { fifths: Math.max(-7, Math.min(7, fifths)), minor: data[1] === 1 };
          } else if (type === 0x03 && !trackName) {
            trackName = new TextDecoder().decode(data).trim();
          }
        } else if (first === 0xf0 || first === 0xf7) {
          chunk.bytes(chunk.vlq());
        } else {
          const command = first & 0xf0;
          const channel = first & 0x0f;
          if (command === 0x90) {
            const pitch = chunk.u8();
            const velocity = chunk.u8();
            if (velocity > 0) {
              const key = `${channel}:${pitch}`;
              const list = open.get(key) ?? [];
              list.push({ start: tick, velocity });
              open.set(key, list);
              partFor(channel);
            } else {
              closeNote(channel, pitch);
            }
          } else if (command === 0x80) {
            const pitch = chunk.u8();
            chunk.u8();
            closeNote(channel, pitch);
          } else if (command === 0xc0) {
            const value = chunk.u8();
            program.set(channel, value);
            const part = trackParts.get(channel);
            if (part && part.notes.length === 0) part.program = value;
          } else if (command === 0xb0) {
            const controller = chunk.u8();
            const value = chunk.u8();
            if (controller === 7 && !volume.has(channel)) volume.set(channel, value);
            if (controller === 10 && !pan.has(channel)) pan.set(channel, value);
            const part = trackParts.get(channel);
            if (part) {
              if (controller === 7 && part.volume === null) part.volume = value;
              if (controller === 10 && part.pan === null) part.pan = value;
            }
          } else if (command === 0xa0 || command === 0xe0) {
            chunk.u8();
            chunk.u8();
          } else if (command === 0xd0) {
            chunk.u8();
          } else {
            throw new ScoreLoadError("The MIDI file contains data that cannot be read.");
          }
        }
      }
    } catch (error) {
      // A damaged track keeps what was read before the damage.
      if (!(error instanceof ScoreLoadError)) throw error;
    }
    for (const [key, starts] of open) {
      const [channel, pitch] = key.split(":").map(Number) as [number, number];
      while (starts.length > 0) closeNote(channel, pitch);
    }
  }

  return {
    division,
    tempos,
    timeSignatures,
    keySignature,
    parts: [...parts.values()].filter((part) => part.notes.length > 0),
    endTick,
  };
}

// --- Building the score ----------------------------------------------------------------

export interface BarPlan {
  start: number;
  length: number;
  numerator: number;
  denominator: number;
}

/** Bars from the time signature changes, enough to hold every note. */
function planBars(parsed: Parsed): BarPlan[] {
  const changes = [...parsed.timeSignatures].sort((a, b) => a.tick - b.tick);
  const bars: BarPlan[] = [];
  let numerator = 4;
  let denominator = 4;
  let tick = 0;
  let next = 0;
  while ((tick < parsed.endTick || bars.length === 0) && bars.length < MAX_BARS) {
    // A time signature change applies from the bar that starts at or after it.
    while (next < changes.length && changes[next]!.tick <= tick) {
      numerator = Math.max(1, Math.min(32, changes[next]!.numerator));
      denominator = [1, 2, 4, 8, 16, 32].includes(changes[next]!.denominator)
        ? changes[next]!.denominator
        : 4;
      next++;
    }
    const length = (QUARTER_TICKS * 4 * numerator) / denominator;
    bars.push({ start: tick, length, numerator, denominator });
    tick += length;
  }
  return bars;
}

/**
 * Moves the notes onto the real grid when they do not follow the file's own tempo.
 * Only files with one tempo and one time signature are checked: files with changes
 * were written to a grid on purpose. Returns the detected tempo, or null.
 */
export function regrid(parsed: Parsed): number | null {
  const bpms = new Set(parsed.tempos.map((t) => Math.round(t.bpm * 1000)));
  const signatures = new Set(parsed.timeSignatures.map((t) => `${t.numerator}/${t.denominator}`));
  if (bpms.size > 1 || signatures.size > 1) return null;
  const signature = parsed.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  if (![2, 4, 8, 16].includes(signature.denominator)) return null;
  const onsets = parsed.parts.flatMap((part) =>
    part.notes.map((note) => ({ tick: note.start, pitch: note.pitch, drum: part.channel === 9 })),
  );
  const beatSteps = 16 / signature.denominator;
  const grid = findGrid(onsets, GRID, signature.numerator * beatSteps, beatSteps);
  if (!grid) return null;
  let endTick = 0;
  for (const part of parsed.parts) {
    for (const note of part.notes) {
      note.start = Math.round(grid.map(note.start));
      note.end = Math.max(note.start + 1, Math.round(grid.map(note.end)));
      endTick = Math.max(endTick, note.end);
    }
  }
  parsed.endTick = endTick;
  const bpm = Math.round((parsed.tempos[0]?.bpm ?? 120) * grid.speed);
  parsed.tempos = [{ tick: 0, bpm }];
  parsed.timeSignatures = parsed.timeSignatures.slice(0, 1).map((t) => ({ ...t, tick: 0 }));
  return bpm;
}

/**
 * How the notes sit on the file's own sixteenth notes: the mean distance in sixteenths (0 = on
 * the grid) and whether that is close enough to need no regrid. The error is null for few notes.
 */
export function gridFit(parsed: Parsed): { error: number | null; follows: boolean } {
  const onsets = parsed.parts.flatMap((part) =>
    part.notes.map((note) => ({ tick: note.start, pitch: note.pitch, drum: part.channel === 9 })),
  );
  return { error: gridError(onsets, GRID), follows: fitsGrid(onsets, GRID) };
}

/** The largest single note value (dotted or not) that fits in `ticks`. */
function largestFit(ticks: number): { duration: Duration; dots: number } | null {
  const first = fillDurations(ticks)[0];
  return first ?? null;
}

const isGuitarProgram = (program: number) => program >= 24 && program <= 31;
const isBassProgram = (program: number) => program >= 32 && program <= 39;

// --- Lead lines over chords ---------------------------------------------------------------

/** A top note this far above the rest of its chord, and at least this high, is a lead line. */
const LEAD_GAP = 7;
const LEAD_MIN_PITCH = 67;
/** A part is split only when it has this many lead notes, and they are this share of its beats. */
const LEAD_MIN_COUNT = 8;
const LEAD_MIN_SHARE = 0.05;

/**
 * A MIDI file keeps every instrument of a channel in one track, so a rhythm
 * guitar and a lead guitar playing together arrive as one: chords with a high
 * melody note on top. When such top notes keep coming, they are moved to a
 * track of their own. Returns the part as it is when it has no clear lead.
 */
function splitLead(part: Part): Part[] {
  if (part.channel === 9 || isBassProgram(part.program)) return [part];
  const beats = new Map<number, RawNote[]>();
  for (const note of part.notes) {
    const key = Math.round(note.start / GRID);
    const list = beats.get(key);
    if (list) list.push(note);
    else beats.set(key, [note]);
  }
  const lead = new Set<RawNote>();
  let leadBeats = 0;
  for (const notes of beats.values()) {
    const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => b - a);
    const top = pitches[0]!;
    if (pitches.length < 2 || top < LEAD_MIN_PITCH || top - pitches[1]! < LEAD_GAP) continue;
    leadBeats++;
    for (const note of notes) if (note.pitch === top) lead.add(note);
  }
  if (leadBeats < LEAD_MIN_COUNT || leadBeats < beats.size * LEAD_MIN_SHARE) return [part];
  // Where the melody plays alone, it belongs to the lead too.
  for (const notes of beats.values()) {
    if (notes.length === 1 && notes[0]!.pitch >= LEAD_MIN_PITCH) lead.add(notes[0]!);
  }
  return [
    { ...part, notes: part.notes.filter((n) => !lead.has(n)) },
    { ...part, trackName: `${part.trackName || "Track"} (lead)`, notes: [...lead] },
  ].filter((p) => p.notes.length > 0);
}

function trackSpec(part: Part, name: string): NewTrack {
  if (part.bass) return { kind: "pitched", name, program: part.program, bass: true };
  if (part.tuning)
    return { kind: "stringed", name, program: part.program, tuning: [...part.tuning] };
  if (part.channel === 9) return { kind: "drums", name, program: 0 };
  if (isGuitarProgram(part.program)) {
    return { kind: "stringed", name, program: part.program, tuning: [...STANDARD_GUITAR] };
  }
  if (isBassProgram(part.program)) {
    return { kind: "stringed", name, program: part.program, tuning: [...STANDARD_BASS] };
  }
  return { kind: "pitched", name, program: part.program };
}

interface Group {
  start: number;
  length: number;
  pitches: number[];
}

export interface FillOptions {
  /** The track's bar that the first planned bar is written to. */
  firstBar?: number;
  /** Replace bars that get no notes with rests (punching a take over old music). */
  overwrite?: boolean;
}

/** Fills the bars of a track with the notes of a part. */
export function fillTrack(
  track: Track,
  part: Part,
  bars: BarPlan[],
  warnings: Set<string>,
  { firstBar = 0, overwrite = false }: FillOptions = {},
) {
  const staff = track.staves[0]!;
  const tuning = staff.stringTuning.tunings;
  const drums = part.channel === 9;

  // Notes per bar, snapped to the grid.
  const perBar: Group[][] = bars.map(() => []);
  let barIndex = 0;
  for (const note of [...part.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
    // A note played just before a bar line belongs on that bar's first beat.
    while (barIndex + 1 < bars.length && note.start + GRID / 2 >= bars[barIndex + 1]!.start) {
      barIndex++;
    }
    const bar = bars[barIndex]!;
    let start = Math.max(0, Math.round((note.start - bar.start) / GRID) * GRID);
    if (start >= bar.length) start = bar.length - GRID;
    const length = Math.max(GRID, Math.round((note.end - note.start) / GRID) * GRID);
    const groups = perBar[barIndex]!;
    const group = groups.find((g) => g.start === start);
    if (group) {
      group.length = Math.max(group.length, length);
      if (!group.pitches.includes(note.pitch)) group.pitches.push(note.pitch);
    } else {
      groups.push({ start, length, pitches: [note.pitch] });
    }
  }
  for (const groups of perBar) groups.sort((a, b) => a.start - b.start);

  // Strings and frets for the whole part at once, so the hand stays near one position.
  let placed: PlacedGroup[] | null = null;
  if (!drums && tuning.length > 0) {
    placed = placeFrets(
      tuning,
      perBar.flatMap((groups) => groups.map((g) => ({ pitches: g.pitches }))),
      { capo: staff.capo },
    );
    reportPlacement(track, placed, lowestPitch(tuning, staff.capo), warnings);
  }
  let placedIndex = 0;

  bars.forEach((plan, index) => {
    const bar = staff.bars[firstBar + index];
    if (!bar) return;
    const groups = perBar[index]!;
    if (groups.length === 0) {
      // The bar keeps its rests, or loses its old music when a take is punched in.
      if (overwrite) clearVoices(bar, 0);
      return;
    }
    const voice = bar.voices[0]!;
    const beats: model.Beat[] = [];
    const rests = (ticks: number) => {
      for (const { duration, dots } of fillDurations(ticks)) beats.push(newBeat(duration, dots));
    };
    let position = 0;
    groups.forEach((group, i) => {
      if (group.start > position) rests(group.start - position);
      const next = groups[i + 1]?.start ?? plan.length;
      const room = next - group.start;
      const fit = largestFit(Math.min(group.length, room)) ?? { duration: D.SixtyFourth, dots: 0 };
      const beat = newBeat(fit.duration, fit.dots);
      if (placed) {
        for (const spot of placed[placedIndex++]!.notes) {
          const note = new model.Note();
          note.string = spot.string;
          note.fret = spot.fret;
          beat.addNote(note);
        }
      } else {
        for (const pitch of [...group.pitches].sort((a, b) => b - a)) {
          const note = new model.Note();
          if (drums) {
            note.percussionArticulation = pitch;
          } else {
            // A transposing staff sounds its written value minus its transposition: write what
            // gives the pitch that was heard.
            const written = pitch + staff.transpositionPitch;
            note.octave = Math.floor(written / 12);
            note.tone = ((written % 12) + 12) % 12;
          }
          beat.addNote(note);
        }
      }
      if (beat.notes.length === 0) {
        beats.push(newBeat(fit.duration, fit.dots));
      } else {
        beats.push(beat);
      }
      position = group.start + durationTicks(fit.duration, fit.dots);
      if (room > durationTicks(fit.duration, fit.dots)) {
        rests(room - durationTicks(fit.duration, fit.dots));
        position = next;
      }
    });
    if (position < plan.length) rests(plan.length - position);
    voice.beats = [];
    for (const beat of beats) voice.addBeat(beat);
    if (overwrite) clearVoices(bar, 1);
  });
}

/** Empties the voices of a bar, from voice `from` on, back to rests. */
function clearVoices(bar: model.Bar, from: number) {
  for (let index = from; index < bar.voices.length; index++) {
    const voice = bar.voices[index]!;
    voice.beats = [];
    for (const beat of placeholderBeats(bar.masterBar, index)) voice.addBeat(beat);
  }
}

/** Notes this far (semitones) below the lowest string may come from a lower tuning: the warning asks. */
const TUNING_HINT_RANGE = 7;

/** Warnings for notes the placement moved an octave or left out. */
function reportPlacement(
  track: Track,
  placed: readonly PlacedGroup[],
  lowest: number,
  warnings: Set<string>,
) {
  const below: number[] = [];
  let belowMoved = false;
  let belowLeftOut = false;
  let moved = false;
  let leftOut = false;
  for (const group of placed) {
    for (const pitch of group.shifted) {
      if (pitch < lowest) {
        below.push(pitch);
        belowMoved = true;
      } else {
        moved = true;
      }
    }
    for (const pitch of group.dropped) {
      if (pitch < lowest) {
        below.push(pitch);
        belowLeftOut = true;
      } else {
        leftOut = true;
      }
    }
  }
  if (moved) {
    warnings.add(`Some notes of “${track.name}” were moved an octave to fit the strings.`);
  }
  if (leftOut) {
    warnings.add(`Some notes of “${track.name}” are outside the strings' range and were left out.`);
  }
  if (below.length > 0) {
    const lowestBelow = Math.min(...below);
    const what =
      belowMoved && belowLeftOut
        ? "moved up an octave or left out"
        : belowMoved
          ? "moved up an octave"
          : "left out";
    const hint =
      lowest - lowestBelow <= TUNING_HINT_RANGE
        ? ` Was the guitar tuned down to ${pitchName(lowestBelow, { octave: false })}?`
        : "";
    const many = below.length > 1;
    warnings.add(
      `${below.length} ${many ? "notes" : "note"} below the low ${pitchName(lowest, { octave: false })} of “${track.name}” ${many ? "were" : "was"} ${what}.${hint}`,
    );
  }
}

/** Builds a Smart Beat score from a MIDI file. Throws {@link ScoreLoadError} for damaged files. */
export function importMidi(bytes: Uint8Array): MidiImport {
  const parsed = parse(bytes);
  if (parsed.parts.length === 0) throw new ScoreLoadError("The MIDI file has no notes.");
  return buildScore(parsed);
}

export interface BuildOptions {
  /** The notes come from a recording, not a file: other wording, and no lead split. */
  recording?: boolean;
}

/** Builds a score from parsed notes: finds the real grid, plans the bars and writes the tracks. */
export function buildScore(parsed: Parsed, { recording = false }: BuildOptions = {}): MidiImport {
  const warnings = new Set<string>();
  const fileBpm = Math.round(parsed.tempos[0]?.bpm ?? 120);
  const detected = regrid(parsed);
  if (detected !== null) {
    warnings.add(
      recording
        ? `The tempo was measured as ${detected} BPM and the bars were lined up with the playing.`
        : `The notes did not follow the file's tempo (${fileBpm} BPM): the tempo was measured as ${detected} BPM and the bars were lined up with the music.`,
    );
  }
  const bars = planBars(parsed);
  if (parsed.endTick > bars.at(-1)!.start + bars.at(-1)!.length) {
    warnings.add(
      recording
        ? "The take is very long: the end was cut off."
        : "The file is very long: the end was cut off.",
    );
  }

  // Scaffold: a song of empty bars with the right time signatures and tempos.
  const score = importer.ScoreLoader.loadAlphaTex(
    `\\track "x" \\staff {score} ${bars.map(() => "r.1").join(" | ")}`,
    new Settings(),
  );
  bars.forEach((plan, index) => {
    const masterBar = score.masterBars[index]!;
    masterBar.timeSignatureNumerator = plan.numerator;
    masterBar.timeSignatureDenominator = plan.denominator;
    if (parsed.keySignature) {
      masterBar.keySignature = parsed.keySignature.fifths;
      masterBar.keySignatureType = parsed.keySignature.minor ? 1 : 0;
    }
  });
  for (const bar of score.tracks[0]!.staves[0]!.bars) {
    bar.keySignature = parsed.keySignature?.fifths ?? 0;
    bar.keySignatureType = parsed.keySignature?.minor ? 1 : 0;
  }

  const tempos = [...parsed.tempos].sort((a, b) => a.tick - b.tick);
  const startTempo = Math.round(tempos[0]?.bpm ?? 120);
  bars.forEach((plan, index) => {
    // The last tempo that starts inside the bar (snapped to its start), or the one already in force.
    const inBar = tempos.filter((t) => t.tick >= plan.start && t.tick < plan.start + plan.length);
    const change = index === 0 ? (inBar[0] ?? { bpm: startTempo }) : inBar.at(-1);
    if (change) {
      score.masterBars[index]!.tempoAutomations = [
        Automation.buildTempoAutomation(false, 0, Math.round(change.bpm), 2),
      ];
    }
  });
  if (tempos.length > bars.length)
    warnings.add("Tempo changes inside a bar start at the beginning of the bar.");

  const parts = recording ? parsed.parts : parsed.parts.flatMap(splitLead);
  if (parts.length > parsed.parts.length) {
    warnings.add(
      "Chords with a lead line on top were split into two tracks (rhythm and lead), as a MIDI file keeps them in one track.",
    );
  }
  for (const part of parts) {
    const base = part.trackName || (part.channel === 9 ? "Drums" : `Track ${score.tracks.length}`);
    const name = uniqueTrackName(score, base);
    const track = createTrack(score, trackSpec(part, name));
    if (part.volume !== null || part.pan !== null) {
      rememberMix(track, {
        volume: (part.volume ?? 100) / 127,
        pan: ((part.pan ?? 64) - 64) / 64,
        mute: false,
        solo: false,
      });
    }
    insertTrack(score, track);
    fillTrack(track, part, bars, warnings);
  }
  removeTrack(score, 0); // the scaffold's placeholder
  refinish(score);

  warnings.add(
    recording
      ? "Notes were snapped to sixteenth notes and triplets are not detected."
      : "MIDI has sounds, not notation: notes were snapped to sixteenth notes and triplets are not detected.",
  );
  return { score, warnings: [...warnings] };
}
