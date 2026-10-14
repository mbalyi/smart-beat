/**
 * Records the audio input chosen in Settings (Record to Tab): mono samples at the audio
 * context's rate, a live level for a meter, and when the first sample was taken.
 */
import { openAudioInput, type AudioInput } from "@/lib/audio/input";
import { contextToPerformance } from "@/lib/audio/take-timing";

/** A take is at most this long: the recorder stops itself. */
export const MAX_TAKE_SECONDS = 10 * 60;

const WORKLET_NAME = "smart-beat-recorder";

/** What a finished take holds. */
export interface Take {
  /** Mono samples, -1…1. */
  samples: Float32Array;
  sampleRate: number;
  /** When the first sample was taken, on `performance.now()`'s clock (ms). */
  startedAt: number;
  /** What the input reports about its delay (seconds); 0 when it does not say. */
  inputLatency: number;
  /** The take ran into {@link MAX_TAKE_SECONDS}. */
  capped: boolean;
}

export interface RecorderOptions {
  /** The loudest sample (0…1) of each block of about 90 ms. */
  onLevel?: (peak: number) => void;
  /** The take reached the limit and is about to be handed over by `stop()`. */
  onLimit?: () => void;
}

export interface Recorder {
  /** Seconds recorded so far. */
  elapsed(): number;
  /** Ends the take and lets go of the input. */
  stop(): Promise<Take>;
  /** Ends the take and throws it away. */
  cancel(): void;
}

const workletUrl = () => `${import.meta.env.BASE_URL}recorder-worklet.js`;

interface SamplesMessage {
  type: "samples";
  samples: Float32Array;
  peak: number;
  /** Context time of the first sample. */
  time: number;
}

/** Opens `input` (null: the system's default) and starts recording. Rejects like `openAudioInput`. */
export async function startRecorder(
  input: AudioInput | null,
  options: RecorderOptions = {},
): Promise<Recorder> {
  const stream = await openAudioInput(input);
  const release = () => stream.getTracks().forEach((track) => track.stop());
  let context: AudioContext | null = null;
  try {
    context = new AudioContext({ latencyHint: "interactive" });
    await context.audioWorklet.addModule(workletUrl());
    await context.resume();
  } catch (error) {
    release();
    void context?.close().catch(() => {});
    throw error;
  }
  const ctx = context;
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: "max",
  });
  source.connect(node);

  const chunks: Float32Array[] = [];
  let length = 0;
  let startedAt: number | null = null;
  let capped = false;
  let finished = false;
  let flushed: (() => void) | null = null;
  const limit = Math.floor(MAX_TAKE_SECONDS * ctx.sampleRate);

  node.port.onmessage = (event: MessageEvent<SamplesMessage | { type: "flushed" }>) => {
    const message = event.data;
    if (message.type === "flushed") {
      flushed?.();
      return;
    }
    if (finished) return;
    if (startedAt === null) {
      const stamp = ctx.getOutputTimestamp?.();
      startedAt =
        stamp && typeof stamp.contextTime === "number" && stamp.performanceTime
          ? contextToPerformance(message.time, {
              contextTime: stamp.contextTime,
              performanceTime: stamp.performanceTime,
            })
          : performance.now();
    }
    const room = limit - length;
    const samples =
      room < message.samples.length ? message.samples.subarray(0, room) : message.samples;
    chunks.push(samples);
    length += samples.length;
    options.onLevel?.(message.peak);
    if (length >= limit && !capped) {
      capped = true;
      options.onLimit?.();
    }
  };

  const close = () => {
    finished = true;
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    release();
    void ctx.close().catch(() => {});
  };

  const latency = (stream.getAudioTracks()[0]?.getSettings?.() as { latency?: number } | undefined)
    ?.latency;

  return {
    elapsed: () => length / ctx.sampleRate,
    async stop() {
      if (finished) throw new Error("The recording has ended.");
      // Ask the audio thread for the samples it still holds.
      await new Promise<void>((resolve) => {
        flushed = resolve;
        node.port.postMessage("flush");
        setTimeout(resolve, 500);
      });
      const sampleRate = ctx.sampleRate;
      close();
      const samples = new Float32Array(length);
      let at = 0;
      for (const chunk of chunks) {
        samples.set(chunk, at);
        at += chunk.length;
      }
      return {
        samples,
        sampleRate,
        startedAt: startedAt ?? performance.now(),
        inputLatency: typeof latency === "number" && Number.isFinite(latency) ? latency : 0,
        capped,
      };
    },
    cancel() {
      if (!finished) close();
    },
  };
}
