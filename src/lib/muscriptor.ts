import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import instrumentIds from "@/lib/audio-transcription/instrument-ids.json";
import { audioDurationMs } from "@/lib/audio-transcription/duration";
import { getAiState } from "@/lib/ai/ai-store";
import { isTauri } from "@/lib/tauri";
import {
  validateAudio,
  type AudioTranscriptionProvider,
  type TranscriptionNote,
  type TranscriptionProgress,
  type TranscriptionResult,
} from "@/lib/audio-transcription/provider";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
};
function stopped(): Error {
  return new DOMException("Transcription stopped.", "AbortError");
}
/** Rejects as soon as `signal` aborts, without waiting for the IPC call to settle. */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    const abort = () => reject(stopped());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
interface NativeResult {
  midiBase64: string;
  notes: TranscriptionNote[];
  durationSeconds: number;
}
/** MuScriptor on this computer (src-tauri/src/transcription.rs): the downloaded model, no upload. */
export const muscriptorProvider: AudioTranscriptionProvider = {
  name: "MuScriptor",
  credit: "MuScriptor is a music transcription model by Kyutai and Mirelo.",
  extensions: Object.keys(MIME),
  instruments: instrumentIds,
  maxBytes: 100 * 1024 * 1024,
  maxDurationMs: 15 * 60_000,
  privacy: "It is transcribed on this computer. Nothing is uploaded.",
  // Only the desktop app can run the model. Whether it is downloaded is the AI store's business.
  configured: () => Promise.resolve(isTauri()),
  async readFile(path) {
    const name = path.split(/[\\/]/).pop() ?? "recording";
    const bytes = await invoke<ArrayBuffer>("read_transcription_audio", { path });
    // The type lets the webview read the duration.
    return new File([bytes], name, { type: MIME[name.split(".").pop()!.toLowerCase()] });
  },
  async transcribe(file, instruments, options) {
    validateAudio(file, this);
    const durationMs = await audioDurationMs(file, options.signal);
    if (durationMs > this.maxDurationMs) {
      throw new Error(`Choose a recording up to ${this.maxDurationMs / 60_000} minutes long.`);
    }
    const operationId = crypto.randomUUID();
    const stopListening = await listen<TranscriptionProgress & { operationId: string }>(
      "transcription-progress",
      ({ payload: { operationId: id, ...progress } }) => {
        if (id === operationId && !options.signal.aborted) options.onProgress(progress);
      },
    );
    // Stops the model between two steps.
    const cancel = () => void invoke("cancel_transcription", { operationId }).catch(() => {});
    try {
      const body = new Uint8Array(await file.arrayBuffer());
      options.signal.throwIfAborted();
      // Rust measures the length again: the limit does not depend on this check.
      const request = invoke<NativeResult>("transcribe_audio", body, {
        headers: {
          "operation-id": operationId,
          "file-type": file.name.split(".").pop()!.toLowerCase(),
          instruments: instruments.join(","),
          "model-size": getAiState().size,
        },
      });
      // Only a request that was sent needs a Cancel in Rust.
      options.signal.addEventListener("abort", cancel, { once: true });
      const result = await withAbort(request, options.signal);
      const binary = atob(result.midiBase64);
      return {
        notes: result.notes,
        durationSeconds: result.durationSeconds,
        midi: Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      } satisfies TranscriptionResult;
    } finally {
      options.signal.removeEventListener("abort", cancel);
      stopListening();
    }
  },
};
