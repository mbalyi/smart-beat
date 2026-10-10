import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import instrumentIds from "@/lib/audio-transcription/instrument-ids.json";
import { audioDurationMs } from "@/lib/audio-transcription/duration";
import { errorText } from "@/lib/errors";
import { isTauri, NotInDesktopAppError } from "@/lib/tauri";
import {
  TranscriptionError,
  validateAudio,
  type AudioTranscriptionProvider,
  type TranscriptionOptions,
  type TranscriptionQuote,
  type TranscriptionResult,
  type TranscriptionNote,
} from "@/lib/audio-transcription/provider";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  aac: "audio/aac",
};
const PAGES = {
  privacy: "https://mirelo.ai/privacy",
  terms: "https://mirelo.ai/terms",
  account: "https://mirelo.ai/studio/",
};
function aborted(): Error {
  return new DOMException(
    "Stopped waiting. The provider job may continue; resume to check the same job.",
    "AbortError",
  );
}
/** Stop waiting on IPC without claiming to cancel the remote paid job. */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
interface NativeResult {
  midiBase64: string;
  notes: TranscriptionNote[];
  durationSeconds: number;
  model?: string | null;
}
interface Snapshot {
  status: string;
  percent?: number;
  result?: NativeResult;
}
export async function waitForMirelo(
  quote: TranscriptionQuote,
  options: TranscriptionOptions,
): Promise<TranscriptionResult> {
  const deadline = Date.now() + Math.min(60 * 60_000, Math.max(10 * 60_000, quote.estimatedMs * 3));
  while (Date.now() < deadline) {
    options.signal.throwIfAborted();
    const snapshot = await withAbort(invoke<Snapshot>("poll_audio"), options.signal);
    if (snapshot.result) {
      const binary = atob(snapshot.result.midiBase64);
      return { ...snapshot.result, midi: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
    }
    options.onProgress({
      phase: "processing",
      message: "Transcribing recording…",
      percent: snapshot.percent,
    });
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(aborted());
      };
      const timer = setTimeout(() => {
        options.signal.removeEventListener("abort", abort);
        resolve();
      }, 2000);
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    });
  }
  throw new Error(
    "This job is taking longer than expected. Resume later to check the same job without paying again.",
  );
}
async function recoverable(cause: unknown): Promise<never> {
  // A definite rejected/failed job is cleared by Rust. An accepted or ambiguous
  // create stays journaled, so the UI offers resume rather than a second create.
  const pending = await invoke<TranscriptionQuote | null>("mirelo_pending").catch(() => true);
  throw new TranscriptionError(errorText(cause), Boolean(pending));
}
export const mireloProvider: AudioTranscriptionProvider = {
  name: "Mirelo Audio-to-MIDI Pro",
  credentialName: "Mirelo",
  accountLabel: "Mirelo Studio",
  extensions: Object.keys(MIME),
  instruments: instrumentIds,
  maxBytes: 100 * 1024 * 1024,
  maxDurationMs: 30 * 60_000,
  retention:
    "Mirelo says API uploads are deleted after 24 hours, and API results expire after 24 hours and are deleted within 7 days. Training copies may remain until account deletion. Paid accounts can opt out of future training in Studio; free accounts cannot. Check the provider privacy policy before uploading sensitive audio.",
  configured: () => (isTauri() ? invoke<boolean>("mirelo_configured") : Promise.resolve(false)),
  // Nothing else is reachable without a saved key.
  saveKey: (key) =>
    isTauri() ? invoke("mirelo_save_key", { key }) : Promise.reject(new NotInDesktopAppError()),
  forgetKey: () => invoke("mirelo_forget_key"),
  async openPage(page) {
    if (isTauri()) return invoke("mirelo_open_page", { page });
    window.open(PAGES[page], "_blank", "noopener");
  },
  async readFile(path) {
    const name = path.split(/[\\/]/).pop() ?? "recording";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const bytes = await invoke<ArrayBuffer>("read_transcription_audio", { path });
    return new File([bytes], name, { type: MIME[ext] });
  },
  async quote(file, options) {
    validateAudio(file, this);
    const durationMs = await audioDurationMs(file, options.signal);
    if (durationMs > this.maxDurationMs)
      throw new Error("Mirelo accepts recordings up to 30 minutes long.");
    const operationId = crypto.randomUUID();
    const stop = await listen<{
      operationId: string;
      phase: "uploading" | "quoting";
      message: string;
    }>("mirelo-upload-progress", ({ payload }) => {
      if (payload.operationId === operationId && !options.signal.aborted)
        options.onProgress(payload);
    });
    try {
      const body = new Uint8Array(await file.arrayBuffer());
      options.signal.throwIfAborted();
      return await withAbort(
        invoke<TranscriptionQuote>("quote_audio", body, {
          headers: {
            "content-type": MIME[file.name.split(".").pop()?.toLowerCase() ?? ""]!,
            "duration-ms": String(durationMs),
            "operation-id": operationId,
          },
        }),
        options.signal,
      );
    } finally {
      stop();
    }
  },
  async transcribe(quote, instruments, options) {
    try {
      options.signal.throwIfAborted();
      await withAbort(invoke("transcribe_audio", { quote, instruments }), options.signal);
      return await waitForMirelo(quote, options);
    } catch (cause) {
      return recoverable(cause);
    }
  },
  pending: () => (isTauri() ? invoke("mirelo_pending") : Promise.resolve(null)),
  async resume(options) {
    try {
      const pending = await this.pending();
      if (!pending) throw new Error("There is no saved transcription to resume.");
      return await waitForMirelo(pending, options);
    } catch (cause) {
      return recoverable(cause);
    }
  },
  discardPending: () => invoke("mirelo_discard_pending"),
};
