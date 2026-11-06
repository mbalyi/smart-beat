import { useEffect, useState } from "react";

import { errorText } from "@/lib/errors";
import { deleteStemSong, listStemSongs, type StemSong } from "@/lib/tauri";

/**
 * The separated songs of this computer. Nothing is listed in a browser, which has no library,
 * or while `enabled` is false.
 */
export function useStemSongs(enabled: boolean) {
  const [songs, setSongs] = useState<StemSong[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    listStemSongs().then(
      (list) => alive && setSongs(list),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [enabled]);

  const remove = async (song: StemSong) => {
    setError("");
    try {
      await deleteStemSong(song.id);
      setSongs((list) => list.filter((item) => item.id !== song.id));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return { songs: enabled ? songs : [], remove, error };
}
