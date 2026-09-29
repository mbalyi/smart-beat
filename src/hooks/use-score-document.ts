import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { describeOpenError, hasScoreExtension } from "@/lib/score/errors";
import { baseName, fileKey } from "@/lib/score/format";
import { initialMix, mixFromScore } from "@/lib/score/mixer";
import type { Score, ScoreSummary } from "@/lib/score/score";
import {
  isTauri,
  loadMixerSettings,
  readScoreFile,
  type CommandError,
  type MixerSettings,
} from "@/lib/tauri";

/** A song opened in the workspace. */
export interface ScoreDocument {
  /** Changes on every open, even of the same file. */
  id: number;
  /** File name, e.g. `song.gp5`. */
  name: string;
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

interface Source {
  name: string;
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

/** Picks the Guitar Pro file from a drop (or the first file, to report it). */
export function firstScoreFile<T>(items: readonly T[], name: (item: T) => string): T | undefined {
  return items.find((item) => hasScoreExtension(name(item))) ?? items[0];
}

/** Opens songs from a path (desktop) or a `File` (browser) and reports failures. */
export function useScoreDocument() {
  const [song, setSong] = useState<ScoreDocument | null>(null);
  const latest = useRef(0);

  const open = useCallback(async ({ name, read }: Source) => {
    const id = ++latest.current;
    const toastId = toast.loading(`Opening “${name}”…`);
    try {
      const bytes = await read();
      // alphaTab is large: load it with the first song, not with the app.
      const { parseScore } = await import("@/lib/score/score");
      const { score, summary } = parseScore(bytes);
      const key = await fileKey(bytes);
      const saved = await savedMix(key);
      toast.dismiss(toastId);
      // Ignore the result if another file was opened meanwhile.
      if (id === latest.current) {
        setSong({ id, name, fileKey: key, score, summary, mix: initialMix(summary, saved) });
      }
    } catch (error) {
      if (id !== latest.current) {
        toast.dismiss(toastId);
        return;
      }
      toast.error(`Couldn't open “${name}”`, {
        id: toastId,
        description: describeOpenError(error),
      });
    }
  }, []);

  const openPath = useCallback(
    (path: string) => open({ name: baseName(path), read: () => readScoreFile(path) }),
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

  return { song, openPath, openFile, newSong };
}
