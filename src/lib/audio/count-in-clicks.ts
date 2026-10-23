/**
 * The count-in of the alphaTab synthesizer path (#182): alphaTab can only count one bar in,
 * so the chosen number of beats is clicked here, with the Web Audio API, before playback starts.
 */

let context: AudioContext | null = null;

const CLICK_SECONDS = 0.03;

export interface ClickRun {
  /** Silences the clicks that have not sounded yet. */
  cancel(): void;
}

/**
 * Clicks `beats` times, `beatSeconds` apart, the first one higher (the first beat of a bar).
 * Returns null when the browser has no Web Audio.
 */
export function playCountInClicks(
  beats: number,
  beatSeconds: number,
  volume: number,
): ClickRun | null {
  try {
    context ??= new AudioContext();
    const ctx = context;
    void ctx.resume();
    const start = ctx.currentTime + 0.02;
    const nodes: OscillatorNode[] = [];
    for (let beat = 0; beat < beats; beat++) {
      const at = start + beat * beatSeconds;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = beat === 0 ? 1760 : 1320;
      gain.gain.setValueAtTime(0.3 * volume, at);
      gain.gain.linearRampToValueAtTime(0, at + CLICK_SECONDS);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + CLICK_SECONDS);
      nodes.push(osc);
    }
    return {
      cancel() {
        for (const osc of nodes) {
          try {
            osc.stop();
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
