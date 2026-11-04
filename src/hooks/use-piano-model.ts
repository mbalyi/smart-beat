import { useCallback, useEffect, useRef, useState } from "react";

import { track } from "@/lib/telemetry";
import { errorText } from "@/lib/errors";
import { downloadPianoModel, isTauri, pianoModelStatus, removePianoModel } from "@/lib/tauri";

/** The high-accuracy piano model: whether it is on this computer, and getting it. */
export interface PianoModel {
  /** The status is known. Until then, nothing about the model is shown. */
  ready: boolean;
  installed: boolean;
  /** The download in bytes. */
  bytes: number;
  /** The download is running, 0…1. */
  progress: number | null;
  /** Why the last download failed. */
  error: string | null;
  download: () => void;
}

/** What the Record to Tab Models dialog adds: deleting the model from this computer. */
export interface ManagedPianoModel extends PianoModel {
  /** A delete is under way. */
  removing: boolean;
  /** Deletes the model. Why it failed is in `error`. */
  remove: () => Promise<void>;
}

/** Looks the model up while `enabled` (the Record dialog is open) and downloads it on request. */
export function usePianoModel(enabled: boolean): ManagedPianoModel {
  const [status, setStatus] = useState<{ installed: boolean; bytes: number } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let current = true;
    pianoModelStatus()
      .then((next) => current && setStatus(next))
      .catch(() => current && setStatus(null));
    return () => {
      current = false;
    };
  }, [enabled]);

  const download = useCallback(() => {
    if (running.current) return;
    running.current = true;
    track("piano_model_download");
    setError(null);
    setProgress(0);
    downloadPianoModel(setProgress)
      .then(() => pianoModelStatus())
      .then(setStatus)
      .catch((reason: unknown) => {
        const message =
          typeof reason === "object" && reason !== null && "message" in reason
            ? String((reason as { message: unknown }).message)
            : "Could not download the piano model.";
        setError(message);
      })
      .finally(() => {
        running.current = false;
        setProgress(null);
      });
  }, []);

  const remove = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setRemoving(true);
    try {
      setStatus(await removePianoModel());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      running.current = false;
      setRemoving(false);
    }
  }, []);

  return {
    removing,
    remove,
    ready: status !== null,
    installed: status?.installed ?? false,
    bytes: status?.bytes ?? 0,
    progress,
    error,
    download,
  };
}
