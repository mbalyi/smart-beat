import { useRef } from "react";
import { toast } from "sonner";

import type { SavedAs, ScoreDocument } from "@/hooks/use-score-document";
import { errorText } from "@/lib/errors";
import {
  exportScore,
  formatFromName,
  FORMATS,
  type ExportFormat,
  type ExportResult,
} from "@/lib/export";
import { encodeWav, type RenderedAudio } from "@/lib/export/wav";
import { baseName, fileKey } from "@/lib/score/format";
import type { ScoreEditor } from "@/lib/score/editor";
import {
  isTauri,
  pickSavePath,
  writeScoreFile,
  type MixerSettings,
  type SaveFilter,
} from "@/lib/tauri";

/** The audio export: a WAV file of the mix. */
const AUDIO_EXTENSION = "wav";
const AUDIO_MIME = "audio/wav";
const AUDIO_FILTER: SaveFilter = { name: "WAV audio", extensions: [AUDIO_EXTENSION] };

/** Formats "Save" and "Save As" write (a song can be reopened from them). */
const SONG_FORMATS: ExportFormat[] = ["gp", "gp5"];

const filterOf = (format: ExportFormat): SaveFilter => ({
  name: FORMATS[format].filter,
  extensions: [FORMATS[format].extension, ...(format === "midi" ? ["midi"] : [])],
});

/** Name of the song without folders or extension: the start of a new file's name. */
export function stem(song: ScoreDocument): string {
  const fromFile = baseName(song.path ?? song.sourceName ?? "").replace(/\.[^.]*$/, "");
  const name = fromFile || song.summary.title || song.name;
  // Characters no file system accepts.
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "Untitled";
}

/** Gives the browser a file to save (used when there is no desktop app). */
function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportWarnings(title: string, { warnings }: ExportResult) {
  if (warnings.length === 0) return;
  toast.warning(title, { description: warnings.join(" "), duration: 12_000 });
}

/**
 * Save, Save As and the exports of the open song. Saving writes Guitar Pro
 * (native `.gp`, or `.gp5`) files; exports write MusicXML, MIDI and ASCII tab
 * without changing which file the song belongs to.
 */
export function useFileActions({
  song,
  editor,
  getMix,
  renderAudio,
  onSaved,
  onEditedChange,
}: {
  song: ScoreDocument;
  editor: ScoreEditor;
  getMix: () => MixerSettings;
  /** Renders the song with the current mix to sound (see `ScorePlayer.renderAudio`). */
  renderAudio?: (onProgress: (fraction: number) => void) => Promise<RenderedAudio>;
  onSaved: (saved: SavedAs) => void;
  onEditedChange?: (edited: boolean) => void;
}) {
  const busy = useRef(false);

  /** Runs `task` unless another save or export is running. */
  const exclusive = async (task: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await task();
    } catch (error) {
      toast.error("Couldn't save the file", { description: errorText(error) });
    } finally {
      busy.current = false;
    }
  };

  const build = (format: ExportFormat): ExportResult => exportScore(editor.score, format, getMix());

  /** Builds the file and writes it to `path` (desktop) or downloads it (browser). */
  async function deliver(format: ExportFormat, path: string | null, result: ExportResult) {
    const name = path ? baseName(path) : `${stem(song)}.${FORMATS[format].extension}`;
    if (path) await writeScoreFile(path, result.bytes);
    else download(result.bytes, name, FORMATS[format].mime);
    return name;
  }

  async function saveTo(format: ExportFormat, path: string | null) {
    const result = build(format);
    const name = await deliver(format, path, result);
    const key = await fileKey(result.bytes);
    editor.markSaved();
    onEditedChange?.(false);
    onSaved({ name, path, fileKey: key });
    toast.success(path ? `Saved “${name}”` : `Downloaded “${name}”`);
    reportWarnings(`“${name}” was saved with limits`, result);
  }

  const saveAs = () =>
    exclusive(async () => {
      let format: ExportFormat = "gp";
      let path: string | null = null;
      if (isTauri()) {
        const dir = song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
        const picked = await pickSavePath(
          `${dir}${stem(song)}.gp`,
          SONG_FORMATS.map(filterOf),
          "Save As",
        );
        if (!picked) return;
        const chosen = formatFromName(picked);
        format = chosen === "gp5" ? "gp5" : "gp";
        // No or another extension: the native format.
        path = chosen === "gp" || chosen === "gp5" ? picked : `${picked}.gp`;
      }
      await saveTo(format, path);
    });

  const save = () => {
    // Replace the file the song came from, if Smart Beat can write that format.
    const known = song.path ? formatFromName(song.path) : null;
    if (song.path && (known === "gp" || known === "gp5")) {
      return exclusive(() => saveTo(known, song.path));
    }
    return saveAs();
  };

  const exportAs = (format: ExportFormat) =>
    exclusive(async () => {
      const info = FORMATS[format];
      let path: string | null = null;
      if (isTauri()) {
        const dir = song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
        path = await pickSavePath(
          `${dir}${stem(song)}.${info.extension}`,
          [filterOf(format)],
          `Export ${info.label}`,
        );
        if (!path) return;
        if (formatFromName(path) !== format) path = `${path}.${info.extension}`;
      }
      const result = build(format);
      const name = await deliver(format, path, result);
      toast.success(path ? `Exported “${name}”` : `Downloaded “${name}”`);
      reportWarnings(`“${name}” was exported with limits`, result);
    });

  /** Exports the mix as a WAV file: rendered by the synthesizer, which takes a few seconds. */
  const exportAudio = () =>
    exclusive(async () => {
      if (!renderAudio) return;
      const name = `${stem(song)}.${AUDIO_EXTENSION}`;
      let path: string | null = null;
      if (isTauri()) {
        const dir = song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
        path = await pickSavePath(`${dir}${name}`, [AUDIO_FILTER], "Export audio");
        if (!path) return;
        if (!path.toLowerCase().endsWith(`.${AUDIO_EXTENSION}`))
          path = `${path}.${AUDIO_EXTENSION}`;
      }
      const toastId = toast.loading("Rendering the audio…");
      try {
        const audio = await renderAudio((fraction) =>
          toast.loading(`Rendering the audio… ${Math.round(fraction * 100)}%`, { id: toastId }),
        );
        const bytes = encodeWav(audio);
        if (path) await writeScoreFile(path, bytes);
        else download(bytes, name, AUDIO_MIME);
        toast.success(path ? `Exported “${baseName(path)}”` : `Downloaded “${name}”`, {
          id: toastId,
        });
      } catch (error) {
        toast.error("Couldn't export the audio", { id: toastId, description: errorText(error) });
      }
    });

  return { save, saveAs, exportAs, exportAudio };
}
