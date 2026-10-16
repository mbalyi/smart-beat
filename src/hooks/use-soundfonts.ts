import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/errors";
import { soundFontFromStored, type SoundFont } from "@/lib/score/soundfonts";
import { track } from "@/lib/telemetry";
import {
  cancelSoundFontDownload,
  downloadCatalogueSoundFont,
  importStoredSoundFont,
  isTauri,
  listStoredSoundFonts,
  pickSoundFontFile,
  removeStoredSoundFont,
  SOUNDFONT_DOWNLOAD_CANCELLED,
  soundFontCatalogue,
  type SoundFontCatalogueItem,
  type SoundFontDownloadProgress,
  type StoredSoundFont,
} from "@/lib/tauri";

/** What is installed, and the recommended banks (with whether each is installed). */
interface Library {
  stored: StoredSoundFont[];
  catalogue: SoundFontCatalogueItem[];
}

/**
 * The SoundFont library is one thing for the whole app, not one per open song: every song tab
 * has its own `ScoreWorkspace`, and a bank imported, downloaded or removed in one must show up
 * in the picker and the dialog of all the others. So the state lives here, outside React, and
 * each workspace subscribes to it.
 */
let library: Library = { stored: [], catalogue: [] };
const listeners = new Set<() => void>();
let started = false;

function publish(next: Library) {
  library = next;
  for (const listener of listeners) listener();
}

/** Reads the library from the app (the desktop app only) and tells every subscriber. */
async function loadLibrary() {
  if (!isTauri()) return;
  try {
    const [stored, catalogue] = await Promise.all([listStoredSoundFonts(), soundFontCatalogue()]);
    publish({ stored, catalogue });
  } catch (error) {
    toast.error("The SoundFonts could not be read", { description: errorText(error) });
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => library;

/** Forgets everything, for tests. */
export function resetSoundFontLibrary() {
  library = { stored: [], catalogue: [] };
  started = false;
  listeners.clear();
}

/**
 * The SoundFonts the user added (#81): imported from their files or downloaded from the
 * catalogue. Empty in a plain browser, where the app data folder does not exist.
 */
export function useSoundFonts() {
  const { stored, catalogue } = useSyncExternalStore(subscribe, snapshot, snapshot);

  // The first song that opens reads the library; the others share what it found.
  useEffect(() => {
    if (started) return;
    started = true;
    void loadLibrary();
  }, []);

  /** The picker entries of the added SoundFonts. */
  const fonts: readonly SoundFont[] = useMemo(() => stored.map(soundFontFromStored), [stored]);

  /** Reads the library again, for example when the dialog opens. */
  const refresh = useCallback(() => loadLibrary(), []);

  /** Imports a file; errors are thrown (the dialog shows them). */
  const importFrom = useCallback(async (path: string): Promise<StoredSoundFont> => {
    const font = await importStoredSoundFont(path);
    track("soundfont_import"); // never the file's name
    toast.success(`Added “${font.name}”`);
    await loadLibrary();
    return font;
  }, []);

  /** Downloads a catalogue bank; errors are thrown, except a download the user cancelled. */
  const download = useCallback(
    async (
      id: string,
      onProgress: (progress: SoundFontDownloadProgress) => void,
    ): Promise<StoredSoundFont | null> => {
      try {
        const font = await downloadCatalogueSoundFont(id, onProgress);
        track("soundfont_download", font.catalogue ?? undefined);
        toast.success(`Downloaded “${font.name}”`);
        await loadLibrary();
        return font;
      } catch (error) {
        if (errorText(error) === SOUNDFONT_DOWNLOAD_CANCELLED) return null;
        throw error;
      }
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      await removeStoredSoundFont(id);
      await loadLibrary();
      return true;
    } catch (error) {
      toast.error("The SoundFont could not be removed", { description: errorText(error) });
      return false;
    }
  }, []);

  return {
    stored,
    fonts,
    catalogue,
    available: isTauri(),
    pick: pickSoundFontFile,
    importFrom,
    download,
    cancelDownload: cancelSoundFontDownload,
    remove,
    refresh,
  };
}
