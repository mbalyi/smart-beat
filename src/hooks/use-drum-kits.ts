import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/errors";
import {
  importKit,
  isTauri,
  listKits,
  pickKitFile,
  removeKit,
  type DrumKit,
  type KitImportOptions,
} from "@/lib/tauri";

/**
 * The user's imported drum kits (#40): the list, importing (the dialog asks
 * about the licence when needed) and removing. Empty in a plain browser.
 */
export function useDrumKits() {
  const [kits, setKits] = useState<DrumKit[]>([]);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setKits(await listKits());
    } catch (error) {
      toast.error("The drum kits could not be read", { description: errorText(error) });
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    listKits()
      .then((list) => current && setKits(list))
      .catch((error: unknown) =>
        toast.error("The drum kits could not be read", { description: errorText(error) }),
      );
    return () => {
      current = false;
    };
  }, []);

  /** Imports a kit; errors are thrown (the dialog shows them next to the licence question). */
  const importFrom = useCallback(
    async (path: string, options: KitImportOptions = {}): Promise<DrumKit> => {
      const kit = await importKit(path, options);
      toast.success(`Imported “${kit.name}”`);
      await refresh();
      return kit;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await removeKit(id);
        await refresh();
      } catch (error) {
        toast.error("The kit could not be removed", { description: errorText(error) });
      }
    },
    [refresh],
  );

  return { kits, available: isTauri(), pick: pickKitFile, importFrom, remove, refresh };
}
