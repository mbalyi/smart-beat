/** Audio export: the rendered mix as a WAV file (16-bit PCM). */

/** Sound rendered by the synthesizer: interleaved samples (-1…1), `channels` per frame. */
export interface RenderedAudio {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

const HEADER_BYTES = 44;

/** Encodes audio as a 16-bit PCM WAV file. Samples beyond -1…1 are clipped. */
export function encodeWav({ samples, sampleRate, channels }: RenderedAudio): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // size of the format chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // bytes per second
  view.setUint16(32, channels * 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(
      HEADER_BYTES + i * 2,
      Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff),
      true,
    );
  }
  return bytes;
}

/** Joins the chunks the synthesizer renders one after the other. */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  const joined = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}
