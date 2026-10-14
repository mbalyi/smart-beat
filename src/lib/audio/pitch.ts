/**
 * Pitch detection for the tuner (#83), after the YIN method (de Cheveigné and Kawahara, 2002):
 * the difference of the signal with itself delayed by each period, normalised by its running
 * mean; the first dip under a threshold is the period, refined between samples by a parabola.
 */

export interface PitchOptions {
  /** Lowest pitch looked for (Hz): a little under a five-string bass's low B (30.9 Hz). */
  minHz?: number;
  /** Highest pitch looked for (Hz): above a guitar's high E at the 12th fret. */
  maxHz?: number;
  /** How clear a period must be (0 perfect … 1 none). */
  threshold?: number;
  /** When no period is that clear: the least clear one still taken. */
  maxDip?: number;
  /**
   * Below this level (RMS) the signal is silence. An instrument plugged straight into an
   * interface rings on for seconds at -40 to -55 dBFS.
   */
  minRms?: number;
}

export interface Pitch {
  hz: number;
  /** 1 for a perfectly periodic signal, towards 0 for noise. */
  clarity: number;
}

/** How many samples `detectPitch` needs to find `minHz`: two periods. */
export const samplesNeeded = (sampleRate: number, minHz = 28) => 2 * Math.ceil(sampleRate / minHz);

/** The pitch of a sound, or null for silence and noise. */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  { minHz = 28, maxHz = 1400, threshold = 0.15, maxDip = 0.5, minRms = 0.001 }: PitchOptions = {},
): Pitch | null {
  let energy = 0;
  for (const s of samples) energy += s * s;
  if (Math.sqrt(energy / samples.length) < minRms) return null;

  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2));
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const width = samples.length - maxTau;
  if (maxTau <= minTau || width <= 0) return null;

  // Cumulative mean normalised difference.
  const d = new Float32Array(maxTau + 1);
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let j = 0; j < width; j++) {
      const diff = samples[j]! - samples[j + tau]!;
      sum += diff * diff;
    }
    running += sum;
    d[tau] = running === 0 ? 1 : (sum * tau) / running;
  }

  let tau = firstDipUnder(d, minTau, maxTau, threshold);
  if (tau < 0) {
    // A ringing string changes a little from one period to the next, so its dip can stay above
    // `threshold`. Then take the deepest dip, or a shorter period almost as deep: the
    // fundamental rather than an octave under it.
    // Only a real dip counts, not a value still falling at the edge of the search.
    let deepest = -1;
    for (let t = minTau + 1; t < maxTau; t++) {
      if (d[t]! <= d[t - 1]! && d[t]! <= d[t + 1]! && (deepest < 0 || d[t]! < d[deepest]!)) {
        deepest = t;
      }
    }
    if (deepest < 0 || d[deepest]! > maxDip) return null;
    tau = firstDipUnder(d, minTau, maxTau, d[deepest]! + 0.05);
  }

  // Between samples: the bottom of the parabola through the dip and its neighbours.
  let exact = tau;
  if (tau > 1 && tau < maxTau) {
    const [a, b, c] = [d[tau - 1]!, d[tau]!, d[tau + 1]!];
    const denominator = a - 2 * b + c;
    if (denominator !== 0) exact = tau + (a - c) / (2 * denominator);
  }
  return { hz: sampleRate / exact, clarity: Math.max(0, 1 - d[tau]!) };
}

/** The bottom of the first dip in `d` under `limit`, or -1. */
function firstDipUnder(d: Float32Array, from: number, to: number, limit: number): number {
  for (let t = from; t <= to; t++) {
    if (d[t]! < limit) {
      while (t + 1 <= to && d[t + 1]! < d[t]!) t++;
      return t;
    }
  }
  return -1;
}

/** MIDI pitch (with fraction) of a frequency: A4 = 440 Hz = 69. */
export const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);

/** How far a frequency is from a MIDI pitch, in cents (positive: sharp). */
export const centsFrom = (hz: number, midi: number) => Math.round((midiOf(hz) - midi) * 100);

/** The open string closest to a frequency, and how far off it is. */
export function nearestString(
  hz: number,
  strings: readonly number[],
): { index: number; cents: number } | null {
  if (strings.length === 0) return null;
  const pitch = midiOf(hz);
  let index = 0;
  strings.forEach((s, i) => {
    if (Math.abs(s - pitch) < Math.abs(strings[index]! - pitch)) index = i;
  });
  return { index, cents: centsFrom(hz, strings[index]!) };
}
