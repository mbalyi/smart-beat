/**
 * The metronome and count-in click sounds, drawn sample by sample (#182). The native engine
 * has the same formulas (`ClickSound` in `src-tauri/src/audio/engine.rs`): change both
 * together. To add a sound: a case in `clickSample` and `clickSeconds` here, in `ClickSound`
 * there, and an entry in `CLICK_SOUNDS` (`practice.ts`) and the `clickSound` transport type.
 */
import type { ClickSoundId } from "@/lib/score/practice";

const TAU = Math.PI * 2;

/** How long a click rings, in seconds. */
export function clickSeconds(sound: ClickSoundId): number {
  switch (sound) {
    case "classic":
      return 0.03;
    case "woodblock":
      return 0.04;
    case "cowbell":
      return 0.12;
    case "bell":
      return 0.25;
  }
}

/** One sample of a click `t` seconds after it started (before the volume). */
export function clickSample(sound: ClickSoundId, accent: boolean, t: number): number {
  const linear = Math.max(0, 1 - t / clickSeconds(sound));
  switch (sound) {
    case "classic": {
      const f = accent ? 1760 : 1320;
      return Math.sin(t * f * TAU) * linear * 0.3;
    }
    case "woodblock": {
      const f = accent ? 2400 : 1800;
      const decay = Math.exp(-t * 110);
      return (Math.sin(t * f * TAU) + 0.4 * Math.sin(t * f * 2.3 * TAU)) * decay * linear * 0.3;
    }
    case "cowbell": {
      const k = accent ? 1.25 : 1;
      const square = (f: number) => (Math.sin(t * f * k * TAU) >= 0 ? 1 : -1);
      return (square(540) + square(800)) * 0.5 * Math.exp(-t * 28) * linear * 0.2;
    }
    case "bell": {
      const f = accent ? 1568 : 1175;
      const partials =
        Math.sin(t * f * TAU) +
        0.5 * Math.sin(t * f * 2.76 * TAU) +
        0.25 * Math.sin(t * f * 5.4 * TAU);
      return partials * Math.exp(-t * 16) * linear * 0.2;
    }
  }
}

/** A click as audio, ready to be played with a gain for the volume. */
export function clickBuffer(ctx: BaseAudioContext, sound: ClickSoundId, accent: boolean) {
  const length = Math.max(1, Math.ceil(clickSeconds(sound) * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = clickSample(sound, accent, i / ctx.sampleRate);
  return buffer;
}
