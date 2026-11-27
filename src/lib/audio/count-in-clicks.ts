/**
 * Clicks of the alphaTab synthesizer path, played with the Web Audio API (#182): alphaTab can
 * only count one bar in and has a single metronome sound, so the chosen count-in beats and
 * the other metronome sounds are played here.
 */
import { clickBuffer } from "@/lib/audio/click-sounds";
import type { ClickSoundId } from "@/lib/score/practice";

let context: AudioContext | null = null;
const buffers = new Map<string, AudioBuffer>();

function audio(): AudioContext {
  context ??= new AudioContext();
  void context.resume();
  return context;
}

/**
 * Opens the click audio ahead of time. A browser only lets a page start sound after a click or a
 * key press, so a context first created by a network message (Practice together: the host's Play
 * starts a count-in on the guest's computer, which nobody touched) stays silent or sounds late.
 * Call this from a click or a key press, e.g. when a session starts.
 */
export function primeClickAudio(): Promise<void> {
  try {
    const ctx = audio();
    // A silent blip: some browsers only count the context as started after it played something.
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start();
    return ctx.state === "running" ? Promise.resolve() : ctx.resume().catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function buffer(ctx: AudioContext, sound: ClickSoundId, accent: boolean): AudioBuffer {
  const key = `${sound}:${accent}`;
  let found = buffers.get(key);
  if (!found) {
    found = clickBuffer(ctx, sound, accent);
    buffers.set(key, found);
  }
  return found;
}

function schedule(
  ctx: AudioContext,
  sound: ClickSoundId,
  accent: boolean,
  volume: number,
  at: number,
): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer(ctx, sound, accent);
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start(at);
  return source;
}

export interface ClickRun {
  /** Silences the clicks that have not sounded yet. */
  cancel(): void;
}

/**
 * Clicks `beats` times, `beatSeconds` apart, the first one accented (the first beat of a bar).
 * Returns null when the browser has no Web Audio.
 */
export function playCountInClicks(
  beats: number,
  beatSeconds: number,
  volume: number,
  sound: ClickSoundId = "classic",
): ClickRun | null {
  try {
    const ctx = audio();
    const start = ctx.currentTime + 0.02;
    const nodes: AudioBufferSourceNode[] = [];
    for (let beat = 0; beat < beats; beat++) {
      nodes.push(schedule(ctx, sound, beat === 0, volume, start + beat * beatSeconds));
    }
    return {
      cancel() {
        for (const node of nodes) {
          try {
            node.stop();
          } catch {
            // Already stopped.
          }
        }
      },
    };
  } catch {
    return null;
  }
}

/** What `clickStartTime` needs of an `AudioContext`. */
export interface ClickClock {
  currentTime: number;
  outputLatency?: number;
  baseLatency?: number;
  getOutputTimestamp?(): AudioTimestamp;
}

const seconds = (ms: number) => ms / 1000;
const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

/**
 * The time on the click audio's own timeline at which a click must start to be heard at the page
 * time `heardAtMs` (`performance.now()` milliseconds; `nowMs` is the page time now). The output's
 * timestamp says which moment of the timeline is heard when; without one, the reported latency
 * is taken off. Never in the past: a click that is late sounds at once.
 */
export function clickStartTime(ctx: ClickClock, heardAtMs: number, nowMs: number): number {
  const stamp = ctx.getOutputTimestamp?.();
  const when =
    stamp && finite(stamp.contextTime) && finite(stamp.performanceTime) && stamp.performanceTime > 0
      ? stamp.contextTime + seconds(heardAtMs - stamp.performanceTime)
      : ctx.currentTime +
        seconds(heardAtMs - nowMs) -
        ((finite(ctx.outputLatency) ? ctx.outputLatency : 0) +
          (finite(ctx.baseLatency) ? ctx.baseLatency : 0));
  return Math.max(ctx.currentTime, when);
}

/**
 * One metronome click: now, or (`heardAtMs`, a `performance.now()` time) scheduled on the audio
 * timeline so that it is heard then, whatever the page is busy with meanwhile.
 */
export function playClick(
  sound: ClickSoundId,
  accent: boolean,
  volume: number,
  heardAtMs?: number,
): void {
  try {
    const ctx = audio();
    const at =
      heardAtMs === undefined ? ctx.currentTime : clickStartTime(ctx, heardAtMs, performance.now());
    schedule(ctx, sound, accent, volume, at);
  } catch {
    // No Web Audio: the click is skipped.
  }
}

/** Two position reports further apart than this from what the time between them says: a jump. */
const JUMP_TOLERANCE_MS = 250;
/** Reports of this last stretch (page ms) are used to place the song on the page's clock. */
const TIMELINE_WINDOW_MS = 2_000;

/**
 * Where the notes player's song time falls on the page's clock, from its position reports. The
 * reports arrive late by a varying amount (they are messages from the audio thread to a busy
 * page), so the earliest-arriving of the recent ones sets the line. A jump (a seek, a loop that
 * restarted) or a new speed starts it over.
 */
export class SongTimeline {
  private reports: { at: number; base: number }[] = [];
  private last: { ms: number; at: number; speed: number } | null = null;

  /** The notes player reported `songMs` (song time, at normal speed) at page time `at`. */
  note(songMs: number, at: number, speed: number): void {
    const last = this.last;
    const expected = last ? last.ms + (at - last.at) * last.speed : songMs;
    if (!last || last.speed !== speed || Math.abs(songMs - expected) > JUMP_TOLERANCE_MS) {
      this.reports = [];
    }
    this.last = { ms: songMs, at, speed };
    this.reports = [
      ...this.reports.filter((r) => r.at >= at - TIMELINE_WINDOW_MS),
      { at, base: at - songMs / speed },
    ];
  }

  /** The page time at which the player renders `songMs`; null before any report. */
  pageTimeOf(songMs: number): number | null {
    const last = this.last;
    if (!last || this.reports.length === 0) return null;
    const base = Math.min(...this.reports.map((r) => r.base));
    return base + songMs / last.speed;
  }

  /** Playback stopped: the next start places the song afresh. */
  reset(): void {
    this.reports = [];
    this.last = null;
  }
}
