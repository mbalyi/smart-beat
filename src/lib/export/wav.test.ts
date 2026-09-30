import { concatSamples, encodeWav } from "@/lib/export/wav";

const text = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.slice(at, at + length));

describe("encodeWav", () => {
  it("writes a 16-bit PCM file with the right header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]); // two stereo frames
    const bytes = encodeWav({ samples, sampleRate: 44_100, channels: 2 });
    const view = new DataView(bytes.buffer);

    expect(text(bytes, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(text(bytes, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(44_100 * 4);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(bytes, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(8);
    expect(bytes.length).toBe(44 + 8);
  });

  it("converts samples to 16-bit integers and clips what is too loud", () => {
    const bytes = encodeWav({
      samples: new Float32Array([0, 0.5, -0.5, 1, -1, 2, -3]),
      sampleRate: 8_000,
      channels: 1,
    });
    const view = new DataView(bytes.buffer);
    const values = Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true));

    expect(values).toEqual([0, 16_384, -16_384, 32_767, -32_768, 32_767, -32_768]);
  });

  it("writes an empty but valid file for no sound", () => {
    const bytes = encodeWav({ samples: new Float32Array(0), sampleRate: 44_100, channels: 2 });
    expect(bytes).toHaveLength(44);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(0);
  });
});

describe("concatSamples", () => {
  it("joins chunks in order", () => {
    const joined = concatSamples([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
  });
});
