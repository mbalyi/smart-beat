import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeTake, isTakeFile, mixToMono } from "@/lib/audio/decode-take";

/** An offline context whose decoder returns `buffer`, or fails when it is null. */
function stubContext(buffer: Partial<AudioBuffer> | null) {
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData() {
        return buffer ? Promise.resolve(buffer) : Promise.reject(new Error("EncodingError"));
      }
    },
  );
}

const audioBuffer = (
  channels: Float32Array<ArrayBuffer>[],
  sampleRate = 22_050,
): Partial<AudioBuffer> => ({
  length: channels[0]!.length,
  duration: channels[0]!.length / sampleRate,
  sampleRate,
  numberOfChannels: channels.length,
  getChannelData: (i: number) => channels[i]!,
});

afterEach(() => vi.unstubAllGlobals());

describe("isTakeFile", () => {
  it("takes the audio types the desktop app reads, in any case", () => {
    expect(isTakeFile("riff.WAV")).toBe(true);
    expect(isTakeFile("riff.mp3")).toBe(true);
    expect(isTakeFile("riff.gp5")).toBe(false);
    expect(isTakeFile("riff")).toBe(false);
  });
});

describe("mixToMono", () => {
  it("averages the channels", () => {
    const mono = mixToMono([new Float32Array([1, 0.5]), new Float32Array([0, 0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0.5]);
  });

  it("copies a single channel", () => {
    const channel = new Float32Array([0.25]);
    const mono = mixToMono([channel]);
    expect(Array.from(mono)).toEqual([0.25]);
    expect(mono).not.toBe(channel);
  });
});

describe("decodeTake", () => {
  it("returns mono samples at the decoded rate", async () => {
    stubContext(audioBuffer([new Float32Array([0.2, 0.4]), new Float32Array([0, 0])]));
    const take = await decodeTake(new ArrayBuffer(8));
    expect(take.sampleRate).toBe(22_050);
    expect(take.samples[0]).toBeCloseTo(0.1);
    expect(take.samples[1]).toBeCloseTo(0.2);
  });

  it("says when the file is not audio", async () => {
    stubContext(null);
    await expect(decodeTake(new ArrayBuffer(8))).rejects.toThrow(
      "Couldn't read this file as audio",
    );
  });

  it("refuses a recording longer than ten minutes", async () => {
    stubContext({ ...audioBuffer([new Float32Array(1)]), duration: 601 });
    await expect(decodeTake(new ArrayBuffer(8))).rejects.toThrow("up to 10 minutes");
  });

  it("refuses a file with no sound", async () => {
    stubContext(audioBuffer([new Float32Array(0)]));
    await expect(decodeTake(new ArrayBuffer(8))).rejects.toThrow("no sound");
  });
});
