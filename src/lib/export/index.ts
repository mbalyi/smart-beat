/**
 * Saving and exporting songs: every format, from a score and its mix to the
 * bytes of a file, plus what could not be saved exactly.
 */
import { withMix } from "@/lib/export/mix";
import { writeAlphaTex } from "@/lib/export/alphatex";
import { writeAsciiTab } from "@/lib/export/ascii-tab";
import { writeGp3, writeGp4, writeGp5 } from "@/lib/export/gp/writer";
import { writeGp7 } from "@/lib/export/gp7";
import { writeMidi } from "@/lib/export/midi";
import { writeMusicXml } from "@/lib/export/musicxml";
import { writeMscx, writeMscz } from "@/lib/export/musescore";
import { writeMxl } from "@/lib/export/mxl";
import type { Score } from "@/lib/score/model";
import type { MixerSettings } from "@/lib/tauri";
import { withoutDrumTabs } from "@/lib/score/drum-tab";

export type ExportFormat =
  | "gp"
  | "gp5"
  | "gp4"
  | "gp3"
  | "mscz"
  | "mscx"
  | "musicxml"
  | "mxl"
  | "midi"
  | "atex"
  | "ascii-tab";

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
  gp4: {
    label: "Guitar Pro 4 (.gp4)",
    extension: "gp4",
    mime: "application/octet-stream",
    filter: "Guitar Pro 4",
  },
  gp3: {
    label: "Guitar Pro 3 (.gp3)",
    extension: "gp3",
    mime: "application/octet-stream",
    filter: "Guitar Pro 3",
  },
  mscz: {
    label: "MuseScore (.mscz)",
    extension: "mscz",
    mime: "application/x-musescore+xml",
    filter: "MuseScore",
  },
  mscx: {
    label: "MuseScore, uncompressed (.mscx)",
    extension: "mscx",
    mime: "application/x-musescore+xml",
    filter: "MuseScore, uncompressed",
  },
  musicxml: {
    label: "MusicXML (.musicxml)",
    extension: "musicxml",
    mime: "application/vnd.recordare.musicxml+xml",
    filter: "MusicXML",
  },
  mxl: {
    label: "Compressed MusicXML (.mxl)",
    extension: "mxl",
    mime: "application/vnd.recordare.musicxml",
    filter: "Compressed MusicXML",
  },
  midi: {
    label: "MIDI (.mid)",
    extension: "mid",
    mime: "audio/midi",
    filter: "MIDI",
  },
  atex: {
    label: "alphaTex (.atex)",
    extension: "atex",
    mime: "text/plain",
    filter: "alphaTex",
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
  // The drum tab's mirror staff is only for the screen.
  return withoutDrumTabs(score, () => buildFile(score, format, mix));
}

function buildFile(score: Score, format: ExportFormat, mix: MixerSettings | null): ExportResult {
  return withMix(score, mix, (): ExportResult => {
    switch (format) {
      case "gp":
        return { bytes: writeGp7(score), warnings: [] };
      case "gp5":
        return writeGp5(score);
      case "gp4":
        return writeGp4(score);
      case "gp3":
        return writeGp3(score);
      case "mscz":
        return writeMscz(score);
      case "mscx":
        return writeMscx(score);
      case "midi":
        return { bytes: writeMidi(score), warnings: [] };
      case "musicxml":
        return { bytes: textEncoder.encode(writeMusicXml(score)), warnings: [] };
      case "mxl":
        return { bytes: writeMxl(score), warnings: [] };
      case "atex":
        return { bytes: textEncoder.encode(writeAlphaTex(score)), warnings: [] };
      case "ascii-tab": {
        const { text, warnings } = writeAsciiTab(score);
        return { bytes: textEncoder.encode(text), warnings };
      }
    }
  });
}
