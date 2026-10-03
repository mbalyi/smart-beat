import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  ENCODING_LABELS,
  type EncodingChoice,
  type TextEncodingId,
} from "@/lib/score/encoding";
import { describeOpenError, hasScoreExtension } from "@/lib/score/errors";
import { baseName, fileKey } from "@/lib/score/format";
import { initialMix, mixFromScore } from "@/lib/score/mixer";
import type { Score, ScoreSummary } from "@/lib/score/score";
import {
  addRecentFile,
  isCommandError,
  isTauri,
  loadMixerSettings,
  readProjectSettings,
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
  /** Guitar Pro 3–5 files: the encoding the text was read with (#53). */
  encoding?: TextEncodingId;
  /** The encoding the user picked for this file, or "auto". */
  encodingChoice?: EncodingChoice;
}

const ENCODING_KEY = "smart-beat:encoding:";

/** The encoding the user picked for a file (by content), or "auto". */
function storedEncoding(key: string): EncodingChoice {
  try {
    const value = localStorage.getItem(ENCODING_KEY + key);
    return value && value in ENCODING_LABELS ? (value as EncodingChoice) : "auto";
  } catch {
    return "auto";
  }
}

function storeEncoding(key: string, choice: EncodingChoice) {
  try {
    if (choice === "auto") localStorage.removeItem(ENCODING_KEY + key);
    else localStorage.setItem(ENCODING_KEY + key, choice);
  } catch {
    // Not remembered; the file still opens with the choice now.
  }
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

/**
 * The mix saved for a song: inside the file itself (`.gp` files saved by
 * Smart Beat), else in the app's settings for this file's content.
 */
async function savedMix(key: string, path?: string): Promise<MixerSettings | null> {
  if (!isTauri()) return null; // settings are only saved in the desktop app
  if (path?.toLowerCase().endsWith(".gp")) {
    try {
      const inFile = await readProjectSettings(path);
      if (inFile) return inFile;
    } catch (error) {
      console.warn("Could not read the settings in the song file", error);
    }
  }
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

/**
 * The open songs (one tab each) and which one is shown. Opens songs from a
 * path (desktop) or a `File` (browser) and reports failures.
 */
export function useScoreDocuments() {
  const [songs, setSongs] = useState<ScoreDocument[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  /** Changes whenever the recent files list was updated by an open. */
  const [recentsVersion, setRecentsVersion] = useState(0);
  const counter = useRef(0);
  const songsRef = useRef<ScoreDocument[]>([]);
  useEffect(() => {
    songsRef.current = songs;
  }, [songs]);

  const add = useCallback((song: ScoreDocument) => {
    setSongs((list) => [...list, song]);
    setActiveId(song.id);
  }, []);

  /** Where each open song was read from, to read it again (Reopen with encoding). */
  const sources = useRef(new Map<number, Source>());

  const open = useCallback(
    async (source: Source, replace?: { id: number; encoding: EncodingChoice }) => {
      const { name, read, path } = source;
      // Opening a song that is already open shows its tab.
      const already =
        path && !replace ? songsRef.current.find((s) => s.path === path) : undefined;
      if (already) {
        setActiveId(already.id);
        return;
      }
      const id = ++counter.current;
      const toastId = toast.loading(`Opening “${name}”…`);
      try {
        const bytes = await read();
        const key = await fileKey(bytes);
        const choice = replace?.encoding ?? storedEncoding(key);
        // alphaTab is large: load it with the first song, not with the app.
        const { loadSong } = await import("@/lib/import");
        const { score, summary, warnings, converted, encoding } = await loadSong(
          bytes,
          name,
          choice,
        );
        if (replace) storeEncoding(key, choice);
        const saved = await savedMix(key, path);
        toast.dismiss(toastId);
        sources.current.set(id, source);
        const song: ScoreDocument = {
          id,
          name,
          // A MIDI or MusicXML file is never replaced by a save: Save asks for a new file.
          path: converted ? null : (path ?? null),
          sourceName: name,
          fileKey: key,
          score,
          summary,
          mix: initialMix(summary, saved),
          ...(encoding && { encoding, encodingChoice: choice }),
        };
        if (replace) {
          // The same tab, read again.
          sources.current.delete(replace.id);
          setSongs((list) => list.map((s) => (s.id === replace.id ? song : s)));
          setActiveId(id);
        } else add(song);
        if (warnings.length > 0) {
          // Long enough to read what was left out.
          toast.warning(`“${name}” was converted`, {
            description: warnings.join(" "),
            duration: 12_000,
          });
        }
        if (path) await rememberRecent(path, true, () => setRecentsVersion((v) => v + 1));
      } catch (error) {
        // A file that is gone is not worth offering again.
        if (path && isCommandError(error) && error.kind === "not-found") {
          await rememberRecent(path, false, () => setRecentsVersion((v) => v + 1));
        }
        toast.error(`Couldn't open “${name}”`, {
          id: toastId,
          description: describeOpenError(error),
        });
      }
    },
    [add],
  );

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
    const id = ++counter.current;
    try {
      const [{ createSong }, { summarizeScore }] = await Promise.all([
        import("@/lib/score/tracks"),
        import("@/lib/score/score"),
      ]);
      const score = createSong();
      const summary = summarizeScore(score);
      add({
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
  }, [add]);

  /**
   * After a save: the song now lives at `saved.path` (null for a download) and
   * its content hash is `saved.fileKey`. The same document, so the workspace
   * stays open.
   */
  const markSaved = useCallback((id: number, saved: SavedAs) => {
    // Read again from where it was saved.
    const { path } = saved;
    if (path) sources.current.set(id, { name: saved.name, path, read: () => readScoreFile(path) });
    setSongs((list) =>
      list.map((song) => (song.id === id ? { ...song, ...saved, isNew: false } : song)),
    );
  }, []);

  /** Reads an open Guitar Pro 3–5 song again with another text encoding (#53). */
  const reopenWithEncoding = useCallback(
    (id: number, encoding: EncodingChoice) => {
      const source = sources.current.get(id);
      if (source) void open(source, { id, encoding });
    },
    [open],
  );

  /** Closes a song's tab; the tab next to it (or none) is shown instead. */
  const close = useCallback((id: number) => {
    const list = songsRef.current;
    const index = list.findIndex((s) => s.id === id);
    if (index < 0) return;
    const rest = list.filter((s) => s.id !== id);
    setSongs(rest);
    sources.current.delete(id);
    setActiveId((current) =>
      current === id ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : current,
    );
  }, []);

  const song = songs.find((s) => s.id === activeId) ?? null;
  return {
    songs,
    song,
    activate: setActiveId,
    close,
    openPath,
    openFile,
    newSong,
    markSaved,
    reopenWithEncoding,
    recentsVersion,
  };
}
