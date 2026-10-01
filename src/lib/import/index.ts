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

/** The lower-case extension of a file name ("song.GP5" → "gp5"), or "". */
const extensionOf = (name: string | undefined) =>
  name?.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";

/**
 * Turns the bytes of any supported file into a score. `name` (the file name)
 * tells text formats apart; other files are recognised by their content.
 * Throws `ScoreLoadError` for damaged files.
 */
export async function loadSong(bytes: Uint8Array, name?: string): Promise<LoadedSong> {
  const extension = extensionOf(name);
  if (extension === "txt") {
    // Text tab: the importer is only loaded for these files.
    const { importAsciiTab } = await import("@/lib/import/ascii-tab");
    const { score, warnings } = importAsciiTab(new TextDecoder().decode(bytes));
    return { score, summary: summarizeScore(score), warnings, converted: true };
  }
  if (extension === "mscx" || extension === "mscz") {
    const { importMuseScore } = await import("@/lib/import/musescore");
    const { score, warnings } = await importMuseScore(bytes);
    return { score, summary: summarizeScore(score), warnings, converted: true };
  }
  if (extension === "atex" || extension === "capx") {
    // alphaTab reads alphaTex and Capella files itself.
    return { ...parseScore(bytes), warnings: [], converted: true };
  }
  if (isMidiFile(bytes)) {
    // The MIDI importer is only loaded for MIDI files: most songs are Guitar Pro files.
    const { importMidi } = await import("@/lib/import/midi");
    const { score, warnings } = importMidi(bytes);
    return { score, summary: summarizeScore(score), warnings, converted: true };
  }
  const loaded = parseScore(bytes);
  return { ...loaded, warnings: [], converted: isXmlFile(bytes) };
}
