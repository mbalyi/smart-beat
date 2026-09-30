/** Opening songs: Guitar Pro and MusicXML go through alphaTab, MIDI files through our own import. */
import { parseScore, summarizeScore, type LoadedScore } from "@/lib/score/score";

export interface LoadedSong extends LoadedScore {
  /** What could not be taken over exactly, for the user. Empty for Guitar Pro files. */
  warnings: string[];
  /** The file is not a Guitar Pro file: saving asks for a new file instead of replacing it. */
  converted: boolean;
}

/** Whether the bytes start like a Standard MIDI file ("MThd"). */
export const isMidiFile = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x4d &&
  bytes[1] === 0x54 &&
  bytes[2] === 0x68 &&
  bytes[3] === 0x64;

/** Whether the bytes are XML (MusicXML), after an optional byte order mark and blanks. */
export function isXmlFile(bytes: Uint8Array): boolean {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)
  )
    i++;
  return bytes[i] === 0x3c;
}

/** Turns the bytes of any supported file into a score. Throws `ScoreLoadError` for damaged files. */
export async function loadSong(bytes: Uint8Array): Promise<LoadedSong> {
  if (isMidiFile(bytes)) {
    // The MIDI importer is only loaded for MIDI files: most songs are Guitar Pro files.
    const { importMidi } = await import("@/lib/import/midi");
    const { score, warnings } = importMidi(bytes);
    return { score, summary: summarizeScore(score), warnings, converted: true };
  }
  const loaded = parseScore(bytes);
  return { ...loaded, warnings: [], converted: isXmlFile(bytes) };
}
