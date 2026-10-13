import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface Processor {
  port: { postMessage: (message: unknown) => void; onmessage: ((event: unknown) => void) | null };
  process(inputs: Float32Array[][]): boolean;
}

/** Runs public/recorder-worklet.js with the globals of the audio thread, and returns its processor. */
function loadProcessor() {
  const source = readFileSync(resolve(__dirname, "../../../public/recorder-worklet.js"), "utf8");
  const messages: { type: string; samples?: Float32Array; time?: number }[] = [];
  let Registered: (new () => Processor) | null = null;
  class AudioWorkletProcessor {
    port = {
      postMessage: (message: (typeof messages)[number]) => messages.push(message),
      onmessage: null,
    };
  }
  const globals = {
    AudioWorkletProcessor,
    registerProcessor: (_name: string, processor: new () => Processor) => {
      Registered = processor;
    },
    currentTime: 0,
    sampleRate: 48_000,
  };
  new Function(...Object.keys(globals), source)(...Object.values(globals));
  return { processor: new Registered!(), messages };
}

const flush = (processor: Processor) => processor.port.onmessage?.({ data: "flush" });

describe("recorder worklet", () => {
  it("mixes the input down to mono", () => {
    const { processor, messages } = loadProcessor();
    processor.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.1)]]);
    flush(processor);
    const samples = messages.find((m) => m.type === "samples")!.samples!;
    expect(samples).toHaveLength(128);
    expect(samples[0]).toBeCloseTo(0.3);
  });

  it("records silence while the input has no channels, so the take keeps time", () => {
    const { processor, messages } = loadProcessor();
    processor.process([[new Float32Array(128).fill(0.5)]]);
    // The input is lost for two calls, then comes back.
    processor.process([[]]);
    processor.process([]);
    processor.process([[new Float32Array(128).fill(0.5)]]);
    flush(processor);
    const samples = messages.find((m) => m.type === "samples")!.samples!;
    expect(samples).toHaveLength(4 * 128);
    expect(samples[128]).toBe(0);
    expect(samples[3 * 128 - 1]).toBe(0);
    expect(samples[3 * 128]).toBeCloseTo(0.5);
  });
});
