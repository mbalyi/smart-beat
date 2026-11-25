/** How a sample folder came into Smart Beat. */
export type SampleFolderKind = "linked" | "imported" | "archive";

/** One folder of samples (mirrors `SampleFolder` in the core, `src-tauri/src/samples`). */
export interface SampleFolder {
  id: string;
  name: string;
  kind: SampleFolderKind;
  /** Where a linked folder lives. */
  path: string | null;
  /** The files can be read now (a linked folder on an unplugged drive cannot). */
  available: boolean;
  fileCount: number | null;
  addedMs: number;
}

/** One audio file in a folder. The measured fields stay null until the file is probed. */
export interface SampleFile {
  /** Path inside the folder, with `/`. */
  rel: string;
  name: string;
  ext: string;
  sizeBytes: number;
  modifiedMs: number;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** A small waveform: 0 to 255 per bin, loudness squashed with a square root. */
  peaks: number[] | null;
}

/** A sample together with the folder it is in. */
export interface SampleRef {
  folderId: string;
  file: SampleFile;
}

/** What a dry run over a folder found. */
export interface FolderScan {
  fileCount: number;
  skipped: number;
  totalBytes: number;
  subfolders: number;
}

/** What an archive holds. */
export interface ArchiveReport {
  name: string;
  sizeBytes: number;
  audioFiles: number;
  skippedFiles: number;
  unpackedBytes: number;
  safe: boolean;
  problem: string | null;
}

/** Progress of a copy or an unpack. */
export interface SampleProgress {
  jobId: string;
  phase: "copying" | "unpacking" | "indexing";
  done: number;
  total: number;
}

/** The three ways to bring samples in. */
export type SampleSource = "link" | "folder" | "archive";
