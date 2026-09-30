/**
 * Saving and exporting songs: every format, from a score and its mix to the
 * bytes of a file, plus what could not be saved exactly.
 */
import { withMix } from "@/lib/export/mix";
import { writeAsciiTab } from "@/lib/export/ascii-tab";
import { writeGp5 } from "@/lib/export/gp5/writer";
import { writeGp7 } from "@/lib/export/gp7";
import { writeMidi } from "@/lib/export/midi";
import { writeMusicXml } from "@/lib/export/musicxml";
import type { Score } from "@/lib/score/model";
import type { MixerSettings } from "@/lib/tauri";

export type ExportFormat = "gp" | "gp5" | "musicxml" | "midi" | "ascii-tab";

export interface FormatInfo {
  label: string;
  extension: string;
  mime: string;
  /** Name of the format in the Save dialog's file type list. */
  filter: string;
}

export const FORMATS: Record<ExportFormat, FormatInfo> = {
  gp: {
    label: "Smart Beat / Guitar Pro 7 (.gp)",
    extension: "gp",
    mime: "application/octet-stream",
    filter: "Guitar Pro 7 (Smart Beat native)",
  },
  gp5: {
    label: "Guitar Pro 5 (.gp5)",
    extension: "gp5",
    mime: "application/octet-stream",
    filter: "Guitar Pro 5",
  },
  musicxml: {
    label: "MusicXML (.musicxml)",
    extension: "musicxml",
    mime: "application/vnd.recordare.musicxml+xml",
    filter: "MusicXML",
  },
  midi: {
    label: "MIDI (.mid)",
    extension: "mid",
    mime: "audio/midi",
    filter: "MIDI",
  },
  "ascii-tab": {
    label: "ASCII tab (.txt)",
    extension: "txt",
    mime: "text/plain",
    filter: "Text",
  },
};

/** The format a file name's extension stands for, if Smart Beat saves it. */
export function formatFromName(name: string): ExportFormat | null {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "midi") return "midi";
  return (
    (Object.keys(FORMATS) as ExportFormat[]).find((f) => FORMATS[f].extension === extension) ?? null
  );
}

export interface ExportResult {
  bytes: Uint8Array;
  /** What the format could not hold, for the user. */
  warnings: string[];
}

const textEncoder = new TextEncoder();

/** Builds the file for `format`, with the mixer's volume, pan, mute and solo in it. */
export function exportScore(
  score: Score,
  format: ExportFormat,
  mix: MixerSettings | null = null,
): ExportResult {
  return withMix(score, mix, (): ExportResult => {
    switch (format) {
      case "gp":
        return { bytes: writeGp7(score), warnings: [] };
      case "gp5":
        return writeGp5(score);
      case "midi":
        return { bytes: writeMidi(score), warnings: [] };
      case "musicxml":
        return { bytes: textEncoder.encode(writeMusicXml(score)), warnings: [] };
      case "ascii-tab": {
        const { text, warnings } = writeAsciiTab(score);
        return { bytes: textEncoder.encode(text), warnings };
      }
    }
  });
}
