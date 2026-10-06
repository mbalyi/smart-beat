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
import { collectDrumLines } from "@/lib/score/drum-lines";
import { baseName, fileKey } from "@/lib/score/format";
import type { ScoreEditor } from "@/lib/score/editor";
import {
  isCommandError,
  isTauri,
  pickSavePath,
  readScoreFile,
  writeM4aFile,
  writeProjectSettings,
  writeScoreFile,
  type MixerSettings,
  type SaveFilter,
} from "@/lib/tauri";

/** The audio exports of the mix: a WAV file, or AAC in an `.m4a` file (made by the system's encoder). */
export type AudioKind = "wav" | "m4a";
const AUDIO: Record<AudioKind, { extension: string; mime: string; filter: SaveFilter }> = {
  wav: {
    extension: "wav",
    mime: "audio/wav",
    filter: { name: "WAV audio", extensions: ["wav"] },
  },
  m4a: {
    extension: "m4a",
    mime: "audio/mp4",
    filter: { name: "M4A audio (AAC)", extensions: ["m4a"] },
  },
};

/** Formats "Save As" offers (a song can be reopened from them). */
const SONG_FORMATS: ExportFormat[] = ["gp", "gp5"];

/** Formats "Save" writes back into the file the song came from. */
const SAVE_IN_PLACE: ExportFormat[] = ["gp", "gp5"];

/** Formats an Export item can also write: the extension typed in the dialog picks one. */
const EXPORT_ALTERNATIVES: Partial<Record<ExportFormat, ExportFormat[]>> = {
  musicxml: ["mxl"],
};

/** Why an audio export can't run here (a browser has no AAC encoder to call), or null. */
export function audioExportProblem(kind: AudioKind, desktop: boolean): string | null {
  return kind === "m4a" && !desktop
    ? "M4A export needs the desktop app. Export a WAV file instead."
    : null;
}

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
 * Save, Save As and the exports of the open song. Saving writes song files
 * (native `.gp` first, then the other Guitar Pro versions and MuseScore);
 * exports write MusicXML, MIDI, alphaTex, ASCII tab and audio without changing
 * which file the song belongs to.
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

  /**
   * Puts the mix (effects, sounds, EQ, automation, drum mixer, audio track,
   * presets) inside a saved `.gp` file, with the recording when the audio
   * track says so. Returns the file's final content key.
   */
  async function storeSettings(path: string, bytes: Uint8Array): Promise<string> {
    // Drum-tab lines have no place in Guitar Pro 7+ files: they go with the settings (#53).
    const drumLines = collectDrumLines(editor.score);
    const mix = { ...getMix(), ...(drumLines.length > 0 && { drumLines }) };
    try {
      await writeProjectSettings(path, mix, !!mix.audioTrack?.embedded);
    } catch (error) {
      if (!(isCommandError(error) && error.kind === "audio")) throw error;
      // The recording is not loaded: save it as a reference only.
      await writeProjectSettings(path, mix, false);
      toast.warning("The recording was not embedded", { description: errorText(error) });
    }
    try {
      return await fileKey(await readScoreFile(path));
    } catch {
      return fileKey(bytes);
    }
  }

  async function saveTo(format: ExportFormat, path: string | null) {
    const result = build(format);
    const name = await deliver(format, path, result);
    const key =
      path && format === "gp" && isTauri()
        ? await storeSettings(path, result.bytes)
        : await fileKey(result.bytes);
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
        if (chosen && SONG_FORMATS.includes(chosen)) {
          format = chosen;
          path = picked;
        } else {
          // No or another extension: the native format.
          path = `${picked}.gp`;
        }
      }
      await saveTo(format, path);
    });

  const save = () => {
    // Replace the file the song came from, if Smart Beat can write that format.
    const known = song.path ? formatFromName(song.path) : null;
    if (song.path && known && SAVE_IN_PLACE.includes(known)) {
      return exclusive(() => saveTo(known, song.path));
    }
    return saveAs();
  };

  const exportAs = (requested: ExportFormat) =>
    exclusive(async () => {
      const info = FORMATS[requested];
      const choices = [requested, ...(EXPORT_ALTERNATIVES[requested] ?? [])];
      let format = requested;
      let path: string | null = null;
      if (isTauri()) {
        const dir = song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
        path = await pickSavePath(
          `${dir}${stem(song)}.${info.extension}`,
          choices.map(filterOf),
          `Export ${info.label}`,
        );
        if (!path) return;
        const chosen = formatFromName(path);
        if (chosen && choices.includes(chosen)) format = chosen;
        else path = `${path}.${info.extension}`;
      }
      const result = build(format);
      const name = await deliver(format, path, result);
      toast.success(path ? `Exported “${name}”` : `Downloaded “${name}”`);
      reportWarnings(`“${name}” was exported with limits`, result);
    });

  /**
   * Exports the mix as a WAV or M4A file: rendered by the synthesizer, which
   * takes a few seconds. M4A is encoded by the desktop app (the operating
   * system's AAC encoder), so a browser can only download WAV files.
   */
  const exportAudio = (kind: AudioKind = "wav") =>
    exclusive(async () => {
      if (!renderAudio) return;
      const { extension, mime, filter } = AUDIO[kind];
      const problem = audioExportProblem(kind, isTauri());
      if (problem) {
        toast.error("Couldn't export the audio", { description: problem });
        return;
      }
      const name = `${stem(song)}.${extension}`;
      let path: string | null = null;
      if (isTauri()) {
        const dir = song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
        path = await pickSavePath(`${dir}${name}`, [filter], "Export audio");
        if (!path) return;
        if (!path.toLowerCase().endsWith(`.${extension}`)) path = `${path}.${extension}`;
      }
      const toastId = toast.loading("Rendering the audio…");
      try {
        const audio = await renderAudio((fraction) =>
          toast.loading(`Rendering the audio… ${Math.round(fraction * 100)}%`, { id: toastId }),
        );
        const bytes = encodeWav(audio);
        if (path && kind === "m4a") await writeM4aFile(path, bytes);
        else if (path) await writeScoreFile(path, bytes);
        else download(bytes, name, mime);
        toast.success(path ? `Exported “${baseName(path)}”` : `Downloaded “${name}”`, {
          id: toastId,
        });
      } catch (error) {
        toast.error("Couldn't export the audio", { id: toastId, description: errorText(error) });
      }
    });

  return { save, saveAs, exportAs, exportAudio };
}
