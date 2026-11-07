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

/** One metronome click now. */
export function playClick(sound: ClickSoundId, accent: boolean, volume: number): void {
  try {
    const ctx = audio();
    schedule(ctx, sound, accent, volume, ctx.currentTime);
  } catch {
    // No Web Audio: the click is skipped.
  }
}
