import { FORMATS, type ExportFormat } from "@/lib/export";

/** What picking an entry of the Export dialog does. */
export type ExportTarget =
  | { kind: "format"; format: ExportFormat }
  | { kind: "audio"; audio: "wav" | "m4a" }
  | { kind: "pdf" };

export interface ExportChoice {
  id: string;
  label: string;
  /** File extension (without the dot) the export writes. */
  extension: string;
  /** What the format keeps or loses, in a line. */
  note: string;
  target: ExportTarget;
}

export interface ExportGroup {
  title: string;
  choices: ExportChoice[];
}

const format = (id: ExportFormat, note: string): ExportChoice => ({
  id,
  label: FORMATS[id].label.replace(/ \(\.[a-z0-9]+\)$/, ""),
  extension: FORMATS[id].extension,
  note,
  target: { kind: "format", format: id },
});

/**
 * Every format Smart Beat can write, grouped for the Export dialog. Audio and PDF only appear
 * where this build can write them (`m4a`: the macOS app, `pdf`: where the app prints to a file).
 */
export function exportGroups({ m4a, pdf }: { m4a: boolean; pdf: boolean }): ExportGroup[] {
  const groups: ExportGroup[] = [
    {
      title: "Guitar Pro and MuseScore",
      choices: [
        format("gp", "Smart Beat's own format. Keeps everything, including your mixer settings."),
        format("gp5", "Opens in Guitar Pro 5 and later. Newer features may be simplified."),
        format("gp4", "Opens in Guitar Pro 4 and later. Newer features may be simplified."),
        format("gp3", "Opens in Guitar Pro 3 and later. Newer features may be simplified."),
        format("mscz", "Opens in MuseScore."),
        format("mscx", "Opens in MuseScore, as plain XML."),
      ],
    },
    {
      title: "Other notation and tab",
      choices: [
        format("musicxml", "Opens in most notation programs."),
        format("mxl", "The same as MusicXML, in a smaller compressed file."),
        format("midi", "Notes and tempo only. No tab, fingerings or other markings."),
        format("atex", "Text that alphaTab can read."),
        format("ascii-tab", "Plain text tab to paste anywhere. Cannot be opened again."),
      ],
    },
  ];
  const sound: ExportChoice[] = [
    {
      id: "wav",
      label: "Audio (WAV)",
      extension: "wav",
      note: "The song as you hear it, rendered to a sound file.",
      target: { kind: "audio", audio: "wav" },
    },
  ];
  if (m4a) {
    sound.push({
      id: "m4a",
      label: "Audio (M4A)",
      extension: "m4a",
      note: "The same sound in a much smaller file.",
      target: { kind: "audio", audio: "m4a" },
    });
  }
  if (pdf) {
    sound.push({
      id: "pdf",
      label: "PDF",
      extension: "pdf",
      note: "The printed page, with print settings.",
      target: { kind: "pdf" },
    });
  }
  groups.push({ title: "Sound and print", choices: sound });
  return groups;
}
