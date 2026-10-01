import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/errors";
import {
  importLibraryFile,
  isTauri,
  listLibrary,
  pickLibraryFile,
  removeLibraryItem,
  updateLibraryItem,
  type AssetKind,
  type LibraryItem,
} from "@/lib/tauri";

/**
 * The user's sound library (amp captures and cabinets) as the UI sees it:
 * the list, and importing, renaming and removing with feedback. Empty in a
 * plain browser, where there is no library.
 */
export function useSoundLibrary() {
  const [items, setItems] = useState<LibraryItem[]>([]);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setItems(await listLibrary());
    } catch (error) {
      toast.error("The sound library could not be read", { description: errorText(error) });
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    listLibrary()
      .then((list) => current && setItems(list))
      .catch((error: unknown) =>
        toast.error("The sound library could not be read", { description: errorText(error) }),
      );
    return () => {
      current = false;
    };
  }, []);

  const importFile = useCallback(
    async (kind: AssetKind): Promise<LibraryItem | null> => {
      if (!isTauri()) {
        toast.error("Importing sounds is only available in the Smart Beat desktop app.");
        return null;
      }
      try {
        const path = await pickLibraryFile(kind);
        if (!path) return null;
        const item = await importLibraryFile(path, kind);
        toast.success(`Imported “${item.name}”`);
        await refresh();
        return item;
      } catch (error) {
        toast.error("The file could not be imported", { description: errorText(error) });
        return null;
      }
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, name: string, tags: string[]) => {
      try {
        await updateLibraryItem(id, name, tags);
        await refresh();
      } catch (error) {
        toast.error("The name could not be changed", { description: errorText(error) });
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await removeLibraryItem(id);
        await refresh();
      } catch (error) {
        toast.error("The item could not be removed", { description: errorText(error) });
      }
    },
    [refresh],
  );

  return { items, importFile, rename, remove };
}
