/**
 * Record to tab: turns the notes found in a recorded take into tablature.
 *
 * Free mode builds a new song and lets the grid finder measure the tempo (the same path as
 * a MIDI file played without a click). Click mode writes the take into an existing track,
 * over the bars it covers, using the song's own tempo.
 */
import { model } from "@coderline/alphatab";

import {
  buildScore,
  fillTrack,
  gridFit,
  regrid,
  type BarPlan,
  type Parsed,
  type Part,
} from "@/lib/import/midi";
import { ScoreLoadError } from "@/lib/score/errors";
import { appendMasterBar, barContent, type Score, type Track } from "@/lib/score/model";
import { durationTicks, QUARTER_TICKS } from "@/lib/score/music";
import { DEFAULT_TEMPO, tempoAt } from "@/lib/score/structure";

/** A note found in a take: seconds from the start of the take, MIDI pitch, velocity 1 to 127. */
export interface RecordedNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
}

/** Safety limit for a take written into a song. */
const MAX_BARS = 2000;
/** Notes this far before the downbeat are moved onto it, earlier ones are left out (seconds). */
const EARLY_GRACE = 0.1;
const SIXTEENTH = QUARTER_TICKS / 4;

/**
 * The time shift (seconds, within plus or minus `maxShift`) that lines the note starts up best
 * with the sixteenth grid, where time 0 is a downbeat. Scans in steps of 1 ms. On a tie the
 * smaller shift wins.
 */
export function alignOffset(
  notes: readonly RecordedNote[],
  beatSeconds: number,
  maxShift = 0.08,
): number {
  const grid = (beatSeconds / 4) * 1000;
  if (notes.length === 0 || !(grid > 0)) return 0;
  const starts = notes.map((note) => note.start * 1000);
  const limit = Math.max(0, Math.round(maxShift * 1000));
  const error = (shift: number) => {
    let sum = 0;
    for (const start of starts) {
      const k = (start + shift) / grid;
      const distance = (k - Math.round(k)) * grid;
      sum += distance * distance;
    }
    return sum / starts.length;
  };
  let best = 0;
  let bestError = error(0);
  for (let step = 1; step <= limit; step++) {
    for (const shift of [-step, step]) {
      const e = error(shift);
      if (e < bestError - 1e-9) {
        best = shift;
        bestError = e;
      }
    }
  }
  return best / 1000;
}

export interface RecordingSong {
  score: Score;
  warnings: string[];
}

/**
 * Tempos the notes are laid out at before the real one is measured. The grid finder only looks
 * 15% either side of the tempo it is given, so these overlap to cover 50 to 240 BPM.
 */
const NOMINAL_TEMPOS = [120, 95, 145, 75, 175, 60, 210];
/** A later tempo must leave this share of the error of the best one so far to replace it. */
const BETTER_FIT = 0.85;

/** The take as notes in ticks, laid out at `bpm`. */
function parsedAt(notes: readonly RecordedNote[], bpm: number, options: FreeOptions): Parsed {
  const ticksPerSecond = (QUARTER_TICKS * bpm) / 60;
  const ticked = notes.map((n) => {
    const start = Math.max(0, Math.round(n.start * ticksPerSecond));
    return {
      start,
      end: Math.max(start + 1, Math.round(n.end * ticksPerSecond)),
      pitch: n.pitch,
      velocity: n.velocity,
    };
  });
  return {
    division: QUARTER_TICKS,
    tempos: [{ tick: 0, bpm }],
    timeSignatures: [],
    keySignature: null,
    parts: [
      {
        trackName: options.trackName,
        tuning: options.tuning,
        channel: 0,
        program: options.program,
        volume: null,
        pan: null,
        notes: ticked,
      },
    ],
    endTick: Math.max(...ticked.map((n) => n.end)),
  };
}

interface FreeOptions {
  tuning: number[];
  trackName: string;
  program: number;
}

/**
 * Free mode: a new song with one guitar track written from the take. The tempo is measured
 * from the notes. A take too short for that stays at 120 BPM, with a warning.
 */
export function recordingToSong(
  notes: readonly RecordedNote[],
  options: FreeOptions,
): RecordingSong {
  const usable = notes.filter(
    (n) => Number.isFinite(n.start) && Number.isFinite(n.end) && n.end >= n.start,
  );
  if (usable.length === 0) throw new ScoreLoadError("The take has no notes.");
  // Try each tempo: the one that leaves the notes closest to the grid wins. An earlier
  // tempo keeps the win unless a later one is clearly better.
  let found: number | undefined;
  let bestError = Infinity;
  for (const bpm of NOMINAL_TEMPOS) {
    const probe = parsedAt(usable, bpm, options);
    if (!gridFit(probe).follows && regrid(probe) === null) continue;
    const error = gridFit(probe).error ?? Infinity;
    if (error < bestError * BETTER_FIT) {
      found = bpm;
      bestError = error;
    }
  }
  const built = buildScore(parsedAt(usable, found ?? DEFAULT_TEMPO, options), { recording: true });
  const warnings = built.warnings;
  if (found === undefined) {
    warnings.unshift(
      `The tempo could not be measured from this take, so the song stays at ${DEFAULT_TEMPO} BPM.`,
    );
  }
  return { score: built.score, warnings };
}

// --- Time in the song ----------------------------------------------------------------------

const barTicks = (masterBar: model.MasterBar) =>
  (QUARTER_TICKS * 4 * masterBar.timeSignatureNumerator) / masterBar.timeSignatureDenominator;

interface TempoMap {
  toTicks: (seconds: number) => number;
  toSeconds: (ticks: number) => number;
}

/**
 * Seconds and ticks from the start of bar `fromBar`, following the song's tempo changes.
 * The last tempo goes on past the end of the song.
 */
function tempoMap(score: Score, fromBar: number): TempoMap {
  const segments: { tick: number; seconds: number; bpm: number }[] = [
    { tick: 0, seconds: 0, bpm: tempoAt(score, fromBar) },
  ];
  let barStart = 0;
  for (let i = fromBar; i < score.masterBars.length; i++) {
    const masterBar = score.masterBars[i]!;
    const length = barTicks(masterBar);
    const changes = masterBar.tempoAutomations
      .filter((a) => a.type === model.AutomationType.Tempo)
      .sort((a, b) => a.ratioPosition - b.ratioPosition);
    for (const change of changes) {
      const tick = barStart + Math.round(change.ratioPosition * length);
      const last = segments.at(-1)!;
      if (tick === last.tick) {
        last.bpm = change.value;
      } else if (tick > last.tick) {
        const seconds = last.seconds + ((tick - last.tick) / QUARTER_TICKS) * (60 / last.bpm);
        segments.push({ tick, seconds, bpm: change.value });
      }
    }
    barStart += length;
  }
  const secondsPerTick = (bpm: number) => 60 / bpm / QUARTER_TICKS;
  return {
    toTicks(seconds) {
      let segment = segments[0]!;
      for (const candidate of segments) if (candidate.seconds <= seconds) segment = candidate;
      return segment.tick + (seconds - segment.seconds) / secondsPerTick(segment.bpm);
    },
    toSeconds(ticks) {
      let segment = segments[0]!;
      for (const candidate of segments) if (candidate.tick <= ticks) segment = candidate;
      return segment.seconds + (ticks - segment.tick) * secondsPerTick(segment.bpm);
    },
  };
}

// --- Click mode ----------------------------------------------------------------------------

/**
 * Everything {@link writeRecording} changes, for `ScoreEditor.run`: the song's structure (bars may
 * be appended in every track) and the bars of the track from `startBar` on. The editor asks for
 * the targets before and after the change, so appended bars are included.
 */
export function recordingTargets(score: Score, trackIndex: number, startBar: number): object[] {
  const staff = score.tracks[trackIndex]?.staves[0];
  return [
    score,
    ...score.tracks.flatMap((track) => [track, ...track.staves]),
    ...(staff ? staff.bars.slice(startBar).flatMap((bar) => [...barContent(bar)]) : []),
  ];
}

/**
 * Click mode: writes a take into a guitar track, from the first beat of bar `startBar` (0-based).
 * The notes' time 0 is that downbeat: the count-in is gone and latency and `alignOffset` are
 * applied. Time follows the song's tempo changes. Every bar the take covers is replaced, rests
 * included. Bars before it and after it stay. Bars are appended when the take outlasts the song.
 *
 * This changes the model without an undo step. Run it inside `editor.run(label, () =>
 * recordingTargets(score, trackIndex, startBar), () => writeRecording(...))` so the whole take
 * is one step.
 */
export function writeRecording(
  score: Score,
  notes: readonly RecordedNote[],
  options: { trackIndex: number; startBar: number },
): { warnings: string[] } {
  const track: Track | undefined = score.tracks[options.trackIndex];
  const staff = track?.staves[0];
  if (!track || !staff || staff.stringTuning.tunings.length === 0) {
    throw new Error("A recording needs a string instrument track.");
  }
  const startBar = Math.max(0, Math.floor(options.startBar));
  const warnings = new Set<string>();

  const usable = notes.filter(
    (n) => Number.isFinite(n.start) && Number.isFinite(n.end) && n.end >= n.start,
  );
  const early = usable.filter((n) => n.start < -EARLY_GRACE);
  if (early.length > 0) {
    warnings.add(
      `${early.length} ${early.length === 1 ? "note" : "notes"} played before the first bar ${early.length === 1 ? "was" : "were"} left out.`,
    );
  }
  const kept = usable.filter((n) => n.start >= -EARLY_GRACE);
  if (kept.length === 0) {
    warnings.add("No notes were found in the take.");
    return { warnings: [...warnings] };
  }

  const map = tempoMap(score, startBar);
  const ticked = kept.map((n) => {
    const start = Math.max(0, Math.round(map.toTicks(n.start)));
    return {
      start,
      end: Math.max(start + 1, Math.round(map.toTicks(n.end))),
      pitch: n.pitch,
      velocity: n.velocity,
    };
  });
  const lastStart = Math.max(...ticked.map((n) => n.start));

  // The bars the take covers, in ticks from the start of `startBar`. A note just before a bar
  // line belongs to the next bar, as when a MIDI file is imported.
  while (score.masterBars.length <= startBar) appendMasterBar(score);
  const plans: BarPlan[] = [];
  let tick = 0;
  let index = startBar;
  do {
    if (index >= score.masterBars.length) appendMasterBar(score);
    const masterBar = score.masterBars[index]!;
    const length = barTicks(masterBar);
    plans.push({
      start: tick,
      length,
      numerator: masterBar.timeSignatureNumerator,
      denominator: masterBar.timeSignatureDenominator,
    });
    tick += length;
    index++;
  } while (tick - SIXTEENTH / 2 <= lastStart && plans.length < MAX_BARS);
  if (tick - SIXTEENTH / 2 <= lastStart)
    warnings.add("The take is very long: the end was cut off.");

  const part: Part = {
    trackName: track.name,
    tuning: [...staff.stringTuning.tunings],
    channel: 0,
    program: track.playbackInfo.program,
    volume: null,
    pan: null,
    notes: ticked,
  };
  fillTrack(track, part, plans, warnings, { firstBar: startBar, overwrite: true });
  return { warnings: [...warnings] };
}

// --- Reading a track back --------------------------------------------------------------------

/** A tab note with its time in seconds from the start of the song. */
export interface TabNote {
  start: number;
  end: number;
  pitch: number;
  string: number;
  fret: number;
}

/** The string notes of a track with their times and sounding pitches (the capo included). */
export function tabNotes(score: Score, trackIndex: number): TabNote[] {
  const staff = score.tracks[trackIndex]?.staves[0];
  if (!staff) return [];
  const map = tempoMap(score, 0);
  const tuning = staff.stringTuning.tunings;
  const out: TabNote[] = [];
  let barStart = 0;
  score.masterBars.forEach((masterBar, index) => {
    for (const voice of staff.bars[index]?.voices ?? []) {
      let tick = barStart;
      for (const beat of voice.beats) {
        const length = durationTicks(beat.duration, beat.dots, {
          numerator: beat.tupletNumerator,
          denominator: beat.tupletDenominator,
        });
        for (const note of beat.notes) {
          const open = tuning[tuning.length - note.string];
          if (open === undefined) continue;
          out.push({
            start: map.toSeconds(tick),
            end: map.toSeconds(tick + length),
            pitch: open + staff.capo + note.fret,
            string: note.string,
            fret: note.fret,
          });
        }
        tick += length;
      }
    }
    barStart += barTicks(masterBar);
  });
  return out.sort((a, b) => a.start - b.start || b.pitch - a.pitch);
}
