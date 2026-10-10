export interface TranscriptionNote {
  pitch: number;
  start: number;
  end: number;
  instrument?: string;
  velocity?: number;
}

export interface TranscriptionResult {
  midi: Uint8Array<ArrayBuffer>;
  notes: TranscriptionNote[];
  durationSeconds: number;
  model?: string | null;
}

export interface TranscriptionQuote {
  assetId: string;
  durationMs: number;
  credits: number;
  estimatedMs: number;
}

export interface TranscriptionProgress {
  phase: "uploading" | "quoting" | "processing" | "downloading";
  message: string;
  percent?: number;
}

export interface TranscriptionOptions {
  signal: AbortSignal;
  onProgress: (progress: TranscriptionProgress) => void;
}

export interface AudioTranscriptionProvider {
  name: string;
  credentialName: string;
  accountLabel: string;
  extensions: readonly string[];
  instruments: readonly string[];
  maxBytes: number;
  maxDurationMs: number;
  retention: string;
  configured(): Promise<boolean>;
  saveKey(key: string): Promise<void>;
  forgetKey(): Promise<void>;
  /** Opens the provider's privacy policy, terms or account page in the browser. */
  openPage(page: "privacy" | "terms" | "account"): Promise<void>;
  readFile(path: string): Promise<File>;
  quote(file: File, options: TranscriptionOptions): Promise<TranscriptionQuote>;
  transcribe(
    quote: TranscriptionQuote,
    instruments: string[],
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult>;
  pending(): Promise<TranscriptionQuote | null>;
  resume(options: TranscriptionOptions): Promise<TranscriptionResult>;
  discardPending(): Promise<void>;
}

export class TranscriptionError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.recoverable = recoverable;
  }
}

export function validateAudio(file: File, provider: AudioTranscriptionProvider): void {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!provider.extensions.includes(extension)) {
    throw new Error(`Choose ${provider.extensions.join(", ")} audio.`);
  }
  if (!file.size) throw new Error("This audio file is empty.");
  if (file.size > provider.maxBytes)
    throw new Error(`This file exceeds the ${provider.maxBytes / 1024 / 1024} MiB upload limit.`);
}
