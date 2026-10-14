import { useCallback, useEffect, useRef, useState } from "react";

import { downloadPianoModel, isTauri, pianoModelStatus } from "@/lib/tauri";

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

/** Looks the model up while `enabled` (the Record dialog is open) and downloads it on request. */
export function usePianoModel(enabled: boolean): PianoModel {
  const [status, setStatus] = useState<{ installed: boolean; bytes: number } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return {
    ready: status !== null,
    installed: status?.installed ?? false,
    bytes: status?.bytes ?? 0,
    progress,
    error,
    download,
  };
}
