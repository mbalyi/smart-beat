// Runs on the audio thread. Mixes the input down to mono and sends it to the page in blocks,
// with the loudest sample of each block (for the level meter). Loaded by src/lib/audio/recorder.ts;
// it is a plain file in public/ so that it also loads under the app's content security policy.
/** The frames of one call of `process`. */
const RENDER_QUANTUM = 128;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
    this.peak = 0;
    // The context time of the first sample of the block being filled.
    this.blockTime = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.send();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  send() {
    if (this.filled === 0) return;
    const samples = this.block.slice(0, this.filled);
    this.port.postMessage({ type: "samples", samples, peak: this.peak, time: this.blockTime }, [
      samples.buffer,
    ]);
    this.filled = 0;
    this.peak = 0;
  }

  process(inputs) {
    // No input connected yet, or the input was lost: record silence, so the take keeps pace
    // with the context clock and later notes keep their time.
    const channels = inputs[0] ?? [];
    const frames = channels.length > 0 ? channels[0].length : RENDER_QUANTUM;
    if (this.filled === 0) this.blockTime = currentTime;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      const value = channels.length > 0 ? sum / channels.length : 0;
      this.block[this.filled++] = value;
      const magnitude = Math.abs(value);
      if (magnitude > this.peak) this.peak = magnitude;
      if (this.filled === this.block.length) {
        this.send();
        if (i + 1 < frames) this.blockTime = currentTime + (i + 1) / sampleRate;
      }
    }
    return true;
  }
}

registerProcessor("smart-beat-recorder", RecorderProcessor);
