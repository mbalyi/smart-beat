/**
 * Standard MIDI file import.
 *
 * A MIDI file has sounds, not notation, so the import makes choices: every
 * MIDI channel that plays notes becomes a track (drums on channel 10), time
 * signatures and tempo changes become bars, and notes are snapped to a grid of
 * sixteenth notes. Guitar and bass sounds are written as tablature in standard
 * tuning; everything else as a staff. What is lost (triplets, dynamics, notes
 * longer than their gap) is listed in the warnings.
 */
import { importer, model, Settings } from "@coderline/alphatab";

import { fillDurations } from "@/lib/score/bar-duration";
import { ScoreLoadError } from "@/lib/score/errors";
import { newBeat, refinish, type Score, type Track } from "@/lib/score/model";
import {
  durationTicks,
  MAX_FRET,
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

interface RawNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
}

interface Part {
  trackName: string;
  channel: number;
  program: number;
  volume: number | null;
  pan: number | null;
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

interface Parsed {
  division: number;
  tempos: { tick: number; bpm: number }[];
  timeSignatures: { tick: number; numerator: number; denominator: number }[];
  keySignature: { fifths: number; minor: boolean } | null;
  parts: Part[];
  endTick: number;
}

function parse(bytes: Uint8Array): Parsed {
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

interface BarPlan {
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

/** The largest single note value (dotted or not) that fits in `ticks`. */
function largestFit(ticks: number): { duration: Duration; dots: number } | null {
  const first = fillDurations(ticks)[0];
  return first ?? null;
}

const isGuitarProgram = (program: number) => program >= 24 && program <= 31;
const isBassProgram = (program: number) => program >= 32 && program <= 39;

function trackSpec(part: Part, name: string): NewTrack {
  if (part.channel === 9) return { kind: "drums", name, program: 0 };
  if (isGuitarProgram(part.program)) {
    return { kind: "stringed", name, program: part.program, tuning: [...STANDARD_GUITAR] };
  }
  if (isBassProgram(part.program)) {
    return { kind: "stringed", name, program: part.program, tuning: [...STANDARD_BASS] };
  }
  return { kind: "pitched", name, program: part.program };
}

/** A string and fret for `pitch`, preferring low frets and strings not in `used`. */
function fretFor(tuning: readonly number[], pitch: number, used: ReadonlySet<number>) {
  let best: { string: number; fret: number } | null = null;
  tuning.forEach((open, index) => {
    const fret = pitch - open;
    const string = tuning.length - index;
    if (fret < 0 || fret > MAX_FRET || used.has(string)) return;
    if (!best || fret < best.fret) best = { string, fret };
  });
  return best as { string: number; fret: number } | null;
}

interface Group {
  start: number;
  length: number;
  pitches: number[];
}

/** Fills the bars of a track with the notes of a part. */
function fillTrack(track: Track, part: Part, bars: BarPlan[], warnings: Set<string>) {
  const staff = track.staves[0]!;
  const tuning = staff.stringTuning.tunings;
  const drums = part.channel === 9;

  // Notes per bar, snapped to the grid.
  const perBar: Group[][] = bars.map(() => []);
  let barIndex = 0;
  for (const note of [...part.notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
    while (barIndex + 1 < bars.length && note.start >= bars[barIndex + 1]!.start) barIndex++;
    const bar = bars[barIndex]!;
    let start = Math.round((note.start - bar.start) / GRID) * GRID;
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

  staff.bars.forEach((bar, index) => {
    const plan = bars[index]!;
    const groups = perBar[index]!.sort((a, b) => a.start - b.start);
    if (groups.length === 0) return; // the track's bar keeps its rests
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
      const used = new Set<number>();
      for (const pitch of [...group.pitches].sort((a, b) => b - a)) {
        const note = new model.Note();
        if (drums) {
          note.percussionArticulation = pitch;
        } else if (tuning.length > 0) {
          let spot = fretFor(tuning, pitch, used);
          if (!spot) {
            for (const shift of [12, -12, 24, -24]) {
              spot = fretFor(tuning, pitch + shift, used);
              if (spot) {
                warnings.add(
                  `Some notes of “${track.name}” were moved an octave to fit the strings.`,
                );
                break;
              }
            }
          }
          if (!spot) {
            warnings.add(
              `Some notes of “${track.name}” are outside the strings' range and were left out.`,
            );
            continue;
          }
          used.add(spot.string);
          note.string = spot.string;
          note.fret = spot.fret;
        } else {
          note.octave = Math.floor(pitch / 12);
          note.tone = pitch % 12;
        }
        beat.addNote(note);
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
  });
}

/** Builds a Smart Beat score from a MIDI file. Throws {@link ScoreLoadError} for damaged files. */
export function importMidi(bytes: Uint8Array): MidiImport {
  const parsed = parse(bytes);
  if (parsed.parts.length === 0) throw new ScoreLoadError("The MIDI file has no notes.");
  const warnings = new Set<string>();
  const bars = planBars(parsed);
  if (parsed.endTick > bars.at(-1)!.start + bars.at(-1)!.length) {
    warnings.add("The file is very long: the end was cut off.");
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

  for (const part of parsed.parts) {
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
    "MIDI has sounds, not notation: notes were snapped to sixteenth notes and triplets are not detected.",
  );
  return { score, warnings: [...warnings] };
}
