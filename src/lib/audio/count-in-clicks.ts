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
