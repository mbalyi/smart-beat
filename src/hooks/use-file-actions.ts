import { useRef, useState } from "react";
import { toast } from "sonner";

import type { ConflictChoice } from "@/components/save-conflict-dialog";
import type { SavedAs, ScoreDocument } from "@/hooks/use-score-document";
import { listCloudAccounts } from "@/lib/cloud";
import {
  cloudErrorText,
  createCloudItem,
  isCloudItem,
  providerLabel,
  providerOf,
  rememberCloudName,
  saveCloudItem,
  type CloudProvider,
} from "@/lib/cloud-items";
import { errorText } from "@/lib/errors";
import { track } from "@/lib/telemetry";
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
  getCloudFolder,
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
const SONG_FORMATS: ExportFormat[] = ["gp", "gp5", "gp4", "gp3", "mscz", "mscx"];

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

/** The folder of the song's file, with its closing separator, or "". */
function songFolder(song: ScoreDocument): string {
  return song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
}

/** Where Save As starts: the linked cloud folder when there is one, else the song's folder. */
async function startFolder(song: ScoreDocument): Promise<string> {
  try {
    const cloud = await getCloudFolder();
    if (cloud) return /[\\/]$/.test(cloud) ? cloud : `${cloud}${cloud.includes("\\") ? "\\" : "/"}`;
  } catch {
    // No cloud folder to offer: the song's own folder will do.
  }
  return songFolder(song);
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
  onReload,
}: {
  song: ScoreDocument;
  editor: ScoreEditor;
  getMix: () => MixerSettings;
  /** Renders the song with the current mix to sound (see `ScorePlayer.renderAudio`). */
  renderAudio?: (onProgress: (fraction: number) => void) => Promise<RenderedAudio>;
  onSaved: (saved: SavedAs) => void;
  onEditedChange?: (edited: boolean) => void;
  /** Reads the song again from its file, dropping the edits ("Reload from disk"). */
  onReload?: () => void;
}) {
  const busy = useRef(false);
  /** The file that changed on disk under a Save, while the user decides what to do. */
  const [conflict, setConflict] = useState<{ name: string } | null>(null);
  /** Save As is asking where to save: this computer or a connected online drive. */
  const [chooser, setChooser] = useState<{
    providers: { provider: CloudProvider; label: string }[];
    copy: boolean;
  } | null>(null);
  /** The online drive the running save talks to, to explain a failure. */
  const cloudProvider = useRef<CloudProvider | null>(null);

  /** Runs `task` unless another save or export is running. */
  const exclusive = async (task: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await task();
    } catch (error) {
      toast.error("Couldn't save the file", {
        description: cloudErrorText(error, cloudProvider.current) ?? errorText(error),
      });
    } finally {
      cloudProvider.current = null;
      busy.current = false;
    }
  };

  /** The last cloud save was kept for later (no connection). */
  const queued = useRef(false);

  const build = (format: ExportFormat): ExportResult => exportScore(editor.score, format, getMix());

  /** Builds the file and writes it to `path` (desktop) or downloads it (browser). */
  async function deliver(
    format: ExportFormat,
    path: string | null,
    result: ExportResult,
    expectedHash?: string,
  ) {
    const name =
      path && isCloudItem(path)
        ? song.name
        : path
          ? baseName(path)
          : `${stem(song)}.${FORMATS[format].extension}`;
    if (path && isCloudItem(path)) {
      cloudProvider.current = providerOf(path);
      queued.current = (await saveCloudItem(path, result.bytes)) === "queued";
    } else if (path) await writeScoreFile(path, result.bytes, expectedHash);
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

  async function saveTo(
    format: ExportFormat,
    path: string | null,
    saveEvent: "save" | "save_as" = "save",
    expectedHash?: string,
  ) {
    const result = build(format);
    const name = await deliver(format, path, result, expectedHash);
    const key =
      path && format === "gp" && isTauri() && !isCloudItem(path)
        ? await storeSettings(path, result.bytes)
        : await fileKey(result.bytes);
    editor.markSaved();
    onEditedChange?.(false);
    onSaved({ name, path, fileKey: key });
    track(saveEvent, FORMATS[format].extension);
    if (path && queued.current) {
      queued.current = false;
      toast.info("Saved offline — it will upload when you are back online", {
        description: `“${name}” is kept on this computer.`,
      });
    } else toast.success(path ? `Saved “${name}”` : `Downloaded “${name}”`);
    reportWarnings(`“${name}” was saved with limits`, result);
  }

  /** Creates the song as a new tab in an online drive and makes it the song's file. */
  const saveToProvider = (provider: CloudProvider) =>
    exclusive(async () => {
      cloudProvider.current = provider;
      const name = `${stem(song)}.gp`;
      const result = build("gp");
      const item = await createCloudItem(provider, name, result.bytes);
      rememberCloudName(item, name);
      editor.markSaved();
      onEditedChange?.(false);
      onSaved({ name, path: item, fileKey: await fileKey(result.bytes) });
      track("save_as", "gp");
      toast.success(`Saved “${name}” to ${providerLabel(provider)}`);
      reportWarnings(`“${name}” was saved with limits`, result);
    });

  const saveAsLocal = (options: { copy?: boolean } = {}) =>
    exclusive(async () => {
      let format: ExportFormat = "gp";
      let path: string | null = null;
      if (isTauri()) {
        const dir = options.copy ? songFolder(song) : await startFolder(song);
        const picked = await pickSavePath(
          `${dir}${stem(song)}${options.copy ? " (copy)" : ""}.gp`,
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
      await saveTo(format, path, "save_as");
    });

  /** Save As: asks where first when an online drive is connected. */
  const saveAs = async (options: { copy?: boolean } = {}) => {
    if (isTauri()) {
      try {
        const connected = (await listCloudAccounts()).filter((a) => a.account);
        if (connected.length > 0) {
          setChooser({
            providers: connected.map(({ provider, label }) => ({ provider, label })),
            copy: !!options.copy,
          });
          return;
        }
      } catch {
        // No drives to offer: the normal dialog.
      }
    }
    return saveAsLocal(options);
  };

  /** Settles the "where to save" question. */
  const chooseTarget = (target: "computer" | CloudProvider | "cancel") => {
    const copy = chooser?.copy;
    setChooser(null);
    if (target === "computer") void saveAsLocal({ copy });
    else if (target !== "cancel") void saveToProvider(target);
  };

  const save = () => {
    // Replace the file the song came from, if Smart Beat can write that format.
    const known = song.path ? formatFromName(isCloudItem(song.path) ? song.name : song.path) : null;
    if (song.path && known && SAVE_IN_PLACE.includes(known)) {
      const path = song.path;
      // The hash of the file as it was opened or last saved: a different file on disk is a
      // conflict (#187) and nothing is written.
      const expectedHash = song.fileKey ?? undefined;
      return exclusive(async () => {
        try {
          await saveTo(known, path, "save", expectedHash);
        } catch (error) {
          if (!(isCommandError(error) && error.kind === "conflict")) throw error;
          setConflict({ name: isCloudItem(path) ? song.name : baseName(path) });
        }
      });
    }
    return saveAs();
  };

  /** Settles a save that found the file changed on disk. */
  const resolveConflict = (choice: ConflictChoice | "cancel") => {
    setConflict(null);
    if (choice === "copy") void saveAs({ copy: true });
    else if (choice === "reload") onReload?.();
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
      track("export", FORMATS[format].extension);
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
        track("export", extension);
        toast.success(path ? `Exported “${baseName(path)}”` : `Downloaded “${name}”`, {
          id: toastId,
        });
      } catch (error) {
        toast.error("Couldn't export the audio", { id: toastId, description: errorText(error) });
      }
    });

  return { save, saveAs, exportAs, exportAudio, conflict, resolveConflict, chooser, chooseTarget };
}
