import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { describeOpenError, hasScoreExtension } from "@/lib/score/errors";
import { baseName, fileKey } from "@/lib/score/format";
import { initialMix, mixFromScore } from "@/lib/score/mixer";
import type { Score, ScoreSummary } from "@/lib/score/score";
import {
  addRecentFile,
  isCommandError,
  isTauri,
  loadMixerSettings,
  readScoreFile,
  removeRecentFile,
  type CommandError,
  type MixerSettings,
} from "@/lib/tauri";

/** A song opened in the workspace. */
export interface ScoreDocument {
  /** Changes on every open, even of the same file. */
  id: number;
  /** File name, e.g. `song.gp5`. */
  name: string;
  /** Full path on disk (desktop app), or null for new songs, browser files and exports. */
  path: string | null;
  /** The name of the file the song was opened from (for naming a converted song's new file). */
  sourceName?: string;
  /** SHA-256 of the file content: the key for per-song settings. Null for new songs. */
  fileKey: string | null;
  score: Score;
  summary: ScoreSummary;
  /** Mix to start with: the user's saved mix, or the one from the file. */
  mix: MixerSettings;
  /** Created with File › New rather than opened. */
  isNew?: boolean;
}

/** Name of a song created with File › New. */
export const NEW_SONG_NAME = "Untitled";

/** What changes about a song when it is saved. */
export interface SavedAs {
  name: string;
  path: string | null;
  fileKey: string;
}

interface Source {
  name: string;
  /** Where the song is saved (desktop app). */
  path?: string;
  read: () => Promise<Uint8Array>;
}

async function savedMix(key: string): Promise<MixerSettings | null> {
  if (!isTauri()) return null; // settings are only saved in the desktop app
  try {
    return await loadMixerSettings(key);
  } catch (error) {
    console.warn("Could not load the saved mix", error);
    return null;
  }
}

/** Adds (or removes) a song in the recent files list; never fails the open. */
async function rememberRecent(path: string, add: boolean, changed: () => void) {
  try {
    await (add ? addRecentFile(path) : removeRecentFile(path));
    changed();
  } catch (error) {
    console.warn("Could not update the recent files", error);
  }
}

/** Picks the Guitar Pro file from a drop (or the first file, to report it). */
export function firstScoreFile<T>(items: readonly T[], name: (item: T) => string): T | undefined {
  return items.find((item) => hasScoreExtension(name(item))) ?? items[0];
}

/** Opens songs from a path (desktop) or a `File` (browser) and reports failures. */
export function useScoreDocument() {
  const [song, setSong] = useState<ScoreDocument | null>(null);
  /** Changes whenever the recent files list was updated by an open. */
  const [recentsVersion, setRecentsVersion] = useState(0);
  const latest = useRef(0);

  const open = useCallback(async ({ name, read, path }: Source) => {
    const id = ++latest.current;
    const toastId = toast.loading(`Opening “${name}”…`);
    try {
      const bytes = await read();
      // alphaTab is large: load it with the first song, not with the app.
      const { loadSong } = await import("@/lib/import");
      const { score, summary, warnings, converted } = await loadSong(bytes);
      const key = await fileKey(bytes);
      const saved = await savedMix(key);
      toast.dismiss(toastId);
      // Ignore the result if another file was opened meanwhile.
      if (id === latest.current) {
        setSong({
          id,
          name,
          // A MIDI or MusicXML file is never replaced by a save: Save asks for a new file.
          path: converted ? null : (path ?? null),
          sourceName: name,
          fileKey: key,
          score,
          summary,
          mix: initialMix(summary, saved),
        });
      }
      if (warnings.length > 0) {
        toast.warning(`“${name}” was converted`, { description: warnings.join(" ") });
      }
      if (path) await rememberRecent(path, true, () => setRecentsVersion((v) => v + 1));
    } catch (error) {
      if (id !== latest.current) {
        toast.dismiss(toastId);
        return;
      }
      // A file that is gone is not worth offering again.
      if (path && isCommandError(error) && error.kind === "not-found") {
        await rememberRecent(path, false, () => setRecentsVersion((v) => v + 1));
      }
      toast.error(`Couldn't open “${name}”`, {
        id: toastId,
        description: describeOpenError(error),
      });
    }
  }, []);

  const openPath = useCallback(
    (path: string) => open({ name: baseName(path), path, read: () => readScoreFile(path) }),
    [open],
  );

  const openFile = useCallback(
    (file: File) =>
      open({
        name: file.name,
        read: async () => {
          if (!hasScoreExtension(file.name)) {
            // The same check the desktop app does in Rust.
            const error: CommandError = { kind: "unsupported-type", message: file.name };
            throw error;
          }
          return new Uint8Array(await file.arrayBuffer());
        },
      }),
    [open],
  );

  /** Starts a new, empty song (File › New). */
  const newSong = useCallback(async () => {
    const id = ++latest.current;
    try {
      const [{ createSong }, { summarizeScore }] = await Promise.all([
        import("@/lib/score/tracks"),
        import("@/lib/score/score"),
      ]);
      const score = createSong();
      const summary = summarizeScore(score);
      if (id !== latest.current) return;
      setSong({
        id,
        name: NEW_SONG_NAME,
        path: null,
        fileKey: null,
        score,
        summary,
        mix: mixFromScore(summary),
        isNew: true,
      });
    } catch (error) {
      toast.error("Couldn't create a new song", { description: String(error) });
    }
  }, []);

  /**
   * After a save: the song now lives at `saved.path` (null for a download) and
   * its content hash is `saved.fileKey`. The same document, so the workspace
   * stays open.
   */
  const markSaved = useCallback((saved: SavedAs) => {
    setSong((current) => (current ? { ...current, ...saved, isNew: false } : current));
  }, []);

  return { song, openPath, openFile, newSong, markSaved, recentsVersion };
}
