/** Reads a recording's duration in milliseconds from its metadata, without decoding it. */
export function audioDurationMs(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let finished = false;
    const finish = (duration?: number, cause?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      if (cause) reject(cause);
      else if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
        reject(new Error("Could not decode the recording duration. Re-export it as WAV or MP3."));
      else resolve(Math.round(duration * 1000));
    };
    const abort = () => finish(undefined, new DOMException("Stopped reading.", "AbortError"));
    const timer = setTimeout(
      () => finish(undefined, new Error("Reading the recording timed out. Try WAV or MP3.")),
      15_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish();
    audio.src = url;
  });
}
