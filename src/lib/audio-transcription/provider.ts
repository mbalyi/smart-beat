export interface TranscriptionNote {
  pitch: number;
  start: number;
  end: number;
  instrument?: string;
  velocity?: number | null;
}

export interface TranscriptionResult {
  midi: Uint8Array<ArrayBuffer>;
  notes: TranscriptionNote[];
  durationSeconds: number;
  model?: string | null;
}

export interface TranscriptionProgress {
  phase: "uploading" | "waiting" | "processing";
  message: string;
  percent?: number | null;
}

export interface TranscriptionOptions {
  /** Aborting stops the transcription, on the server too where the provider can. */
  signal: AbortSignal;
  onProgress: (progress: TranscriptionProgress) => void;
}

export interface AudioTranscriptionProvider {
  name: string;
  /** Who made the model, shown with the privacy note. */
  credit: string;
  extensions: readonly string[];
  instruments: readonly string[];
  maxBytes: number;
  maxDurationMs: number;
  /** What happens to an uploaded recording, shown before upload. */
  privacy: string;
  /** False when this build has no transcription server. */
  configured(): Promise<boolean>;
  readFile(path: string): Promise<File>;
  transcribe(
    file: File,
    instruments: string[],
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult>;
}

export function validateAudio(file: File, provider: AudioTranscriptionProvider): void {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!provider.extensions.includes(extension)) {
    throw new Error(`Choose ${provider.extensions.join(", ").toUpperCase()} audio.`);
  }
  if (!file.size) throw new Error("This audio file is empty.");
  if (file.size > provider.maxBytes)
    throw new Error(`This file exceeds the ${provider.maxBytes / 1024 / 1024} MiB upload limit.`);
}
