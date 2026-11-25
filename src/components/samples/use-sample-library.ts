import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/errors";
import {
  listSampleFiles,
  listSampleFolders,
  probeSampleFiles,
  relinkSampleFolder,
  removeSampleFolder,
} from "@/lib/tauri";
import type { SampleFile, SampleFolder, SampleRef } from "@/lib/samples/types";

/** Files asked for in one call: the core takes at most 64. */
const PROBE_BATCH = 64;

export interface SampleLibrary {
  folders: readonly SampleFolder[];
  /** The folder shown, or null for all of them. */
  folderId: string | null;
  selectFolder: (id: string | null) => void;
  /** The files of the shown folder(s), sorted by name. */
  items: readonly SampleRef[];
  /** The folder list was read at least once. */
  loaded: boolean;
  /** A folder's files are being listed. */
  scanning: boolean;
  /** Puts a folder that was just added into the list and shows it. */
  addFolder: (folder: SampleFolder) => void;
  removeFolder: (id: string, deleteCopy: boolean) => Promise<void>;
  relinkFolder: (id: string, path: string) => Promise<void>;
  /** Measures the files that are on screen (length and waveform), a few at a time. */
  ensureProbed: (refs: readonly SampleRef[]) => void;
}

const byName = (a: SampleRef, b: SampleRef) =>
  a.file.name.localeCompare(b.file.name, undefined, { sensitivity: "base" }) ||
  a.file.rel.localeCompare(b.file.rel);

/** The user's sample folders and the files in them, read from the core (and its cache). */
export function useSampleLibrary(): SampleLibrary {
  const [folders, setFolders] = useState<readonly SampleFolder[]>([]);
  const [files, setFiles] = useState<Readonly<Record<string, readonly SampleFile[]>>>({});
  const [folderId, setFolderId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [scanning, setScanning] = useState(0);
  const requested = useRef(new Set<string>());
  const probing = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    listSampleFolders()
      .then((list) => {
        if (live) setFolders(list);
      })
      .catch((error: unknown) => {
        toast.error("Couldn't read your sample folders", { description: errorText(error) });
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // A folder's files are listed when it first becomes available.
  useEffect(() => {
    for (const folder of folders) {
      if (!folder.available || requested.current.has(folder.id)) continue;
      requested.current.add(folder.id);
      setScanning((n) => n + 1);
      listSampleFiles(folder.id)
        .then((list) => setFiles((all) => ({ ...all, [folder.id]: list })))
        .catch((error: unknown) => {
          requested.current.delete(folder.id);
          toast.error(`Couldn't read “${folder.name}”`, { description: errorText(error) });
        })
        .finally(() => setScanning((n) => n - 1));
    }
  }, [folders]);

  const items = useMemo(() => {
    const shown = folders.filter((f) => folderId === null || f.id === folderId);
    return shown
      .flatMap((f) => (files[f.id] ?? []).map((file): SampleRef => ({ folderId: f.id, file })))
      .sort(byName);
  }, [folders, files, folderId]);

  const addFolder = useCallback((folder: SampleFolder) => {
    setFolders((list) => [...list.filter((f) => f.id !== folder.id), folder]);
    setFolderId(folder.id);
  }, []);

  const removeFolder = useCallback(async (id: string, deleteCopy: boolean) => {
    try {
      await removeSampleFolder(id, deleteCopy);
    } catch (error) {
      toast.error("Couldn't remove the folder", { description: errorText(error) });
      return;
    }
    requested.current.delete(id);
    setFolders((list) => list.filter((f) => f.id !== id));
    setFiles(({ [id]: _gone, ...rest }) => rest);
    setFolderId((current) => (current === id ? null : current));
  }, []);

  const relinkFolder = useCallback(async (id: string, path: string) => {
    try {
      const updated = await relinkSampleFolder(id, path);
      requested.current.delete(id);
      setFolders((list) => list.map((f) => (f.id === id ? updated : f)));
    } catch (error) {
      toast.error("Couldn't use that folder", { description: errorText(error) });
    }
  }, []);

  const ensureProbed = useCallback((refs: readonly SampleRef[]) => {
    const wanted = new Map<string, string[]>();
    for (const { folderId: id, file } of refs) {
      const key = `${id}/${file.rel}`;
      if (file.durationMs !== null || probing.current.has(key)) continue;
      probing.current.add(key);
      wanted.set(id, [...(wanted.get(id) ?? []), file.rel]);
    }
    for (const [id, rels] of wanted) {
      for (let at = 0; at < rels.length; at += PROBE_BATCH) {
        const batch = rels.slice(at, at + PROBE_BATCH);
        probeSampleFiles(id, batch)
          .then((measured) => {
            const found = new Map(measured.map((f) => [f.rel, f]));
            // A file that cannot be decoded stays unmeasured: it is dropped from the list.
            setFiles((all) => ({
              ...all,
              [id]: (all[id] ?? []).flatMap((f) => {
                const next = found.get(f.rel);
                if (!next) return [f];
                return next.durationMs === null ? [] : [next];
              }),
            }));
          })
          .catch(() => {
            for (const rel of batch) probing.current.delete(`${id}/${rel}`);
          });
      }
    }
  }, []);

  return {
    folders,
    folderId,
    selectFolder: setFolderId,
    items,
    loaded,
    scanning: scanning > 0,
    addFolder,
    removeFolder,
    relinkFolder,
    ensureProbed,
  };
}
