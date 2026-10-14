/**
 * Record to Tab from a file: decodes an existing recording into a mono take, like the
 * recorder's. The web view decodes it and the transcriber resamples it again in Rust.
 */
import { MAX_TAKE_SECONDS } from "@/lib/audio/recorder";

/** The file types Record to Tab reads (the same as the desktop app's dropped-audio reader). */
export const TAKE_FILE_EXTENSIONS = ["mp3", "wav", "flac", "ogg"] as const;

/** The rate the file is decoded at: Basic Pitch's own, so little is sent to Rust. */
const DECODE_RATE = 22_050;

/** True when the file name ends in one of {@link TAKE_FILE_EXTENSIONS}. */
export function isTakeFile(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return (TAKE_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

/** The mean of the channels, one sample per frame. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const frames = channels[0]?.length ?? 0;
  if (channels.length === 1) return channels[0]!.slice();
  const mono = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) mono[i]! += channel[i]! / channels.length;
  }
  return mono;
}

/**
 * Decodes a recording into mono samples. Rejects with a message for the player when it is
 * not audio, holds no sound, or is longer than {@link MAX_TAKE_SECONDS}.
 */
export async function decodeTake(
  bytes: ArrayBuffer,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("This window can't read audio files.");
  }
  const context = new OfflineAudioContext(1, 1, DECODE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(bytes);
  } catch {
    throw new Error("Couldn't read this file as audio. Choose an MP3, WAV, FLAC or OGG file.");
  }
  if (buffer.length === 0) throw new Error("The file holds no sound.");
  if (buffer.duration > MAX_TAKE_SECONDS) {
    throw new Error(`Choose a recording up to ${MAX_TAKE_SECONDS / 60} minutes long.`);
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
    buffer.getChannelData(i),
  );
  return { samples: mixToMono(channels), sampleRate: buffer.sampleRate };
}
