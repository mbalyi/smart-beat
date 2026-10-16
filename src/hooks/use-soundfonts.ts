import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * The SoundFonts the user added (#81): imported from their files or downloaded from the
 * catalogue. Empty in a plain browser, where the app data folder does not exist.
 */
export function useSoundFonts() {
  const [stored, setStored] = useState<StoredSoundFont[]>([]);
  const [catalogue, setCatalogue] = useState<SoundFontCatalogueItem[]>([]);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const [list, items] = await Promise.all([listStoredSoundFonts(), soundFontCatalogue()]);
      setStored(list);
      setCatalogue(items);
    } catch (error) {
      toast.error("The SoundFonts could not be read", { description: errorText(error) });
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    Promise.all([listStoredSoundFonts(), soundFontCatalogue()])
      .then(([list, items]) => {
        if (!current) return;
        setStored(list);
        setCatalogue(items);
      })
      .catch((error: unknown) =>
        toast.error("The SoundFonts could not be read", { description: errorText(error) }),
      );
    return () => {
      current = false;
    };
  }, []);

  /** The picker entries of the added SoundFonts. */
  const fonts: readonly SoundFont[] = useMemo(() => stored.map(soundFontFromStored), [stored]);

  /** Imports a file; errors are thrown (the dialog shows them). */
  const importFrom = useCallback(
    async (path: string): Promise<StoredSoundFont> => {
      const font = await importStoredSoundFont(path);
      track("soundfont_import"); // never the file's name
      toast.success(`Added “${font.name}”`);
      await refresh();
      return font;
    },
    [refresh],
  );

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
        await refresh();
        return font;
      } catch (error) {
        if (errorText(error) === SOUNDFONT_DOWNLOAD_CANCELLED) return null;
        throw error;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await removeStoredSoundFont(id);
        await refresh();
        return true;
      } catch (error) {
        toast.error("The SoundFont could not be removed", { description: errorText(error) });
        return false;
      }
    },
    [refresh],
  );

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
