import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/errors";
import {
  onSamplePreviewEnded,
  setSamplePreviewVolume,
  startSamplePreview,
  stopSamplePreview,
} from "@/lib/tauri";
import type { SampleRef } from "@/lib/samples/types";

const VOLUME_KEY = "smart-beat:sample-preview-volume";
const DEFAULT_VOLUME = 0.8;

/** The id of a sample across folders. */
export const sampleKey = (ref: SampleRef) => `${ref.folderId}/${ref.file.rel}`;

function readVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    if (localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(stored)) {
      return Math.min(1, Math.max(0, stored));
    }
  } catch {
    // A browser without storage keeps the default.
  }
  return DEFAULT_VOLUME;
}

export interface SamplePreview {
  /** Key of the sample that plays now. */
  playing: string | null;
  volume: number;
  play: (ref: SampleRef) => void;
  stop: () => void;
  toggle: (ref: SampleRef) => void;
  setVolume: (volume: number) => void;
}

/**
 * Auditions one sample at a time through the engine's own preview voice. It never touches the
 * score. `ensureEngine` returns false (and says why) when no native engine runs.
 */
export function useSamplePreview(ensureEngine: () => boolean): SamplePreview {
  const [playing, setPlaying] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(readVolume);
  const volumeRef = useRef(volume);
  const turn = useRef(0);
  const engineRef = useRef(ensureEngine);
  useEffect(() => {
    engineRef.current = ensureEngine;
  });

  const stop = useCallback(() => {
    turn.current += 1;
    setPlaying(null);
    void stopSamplePreview().catch(() => {});
  }, []);

  const play = useCallback((ref: SampleRef) => {
    if (!engineRef.current()) return;
    const mine = ++turn.current;
    setPlaying(sampleKey(ref));
    startSamplePreview(ref.folderId, ref.file.rel, volumeRef.current).catch((error: unknown) => {
      if (mine !== turn.current) return;
      setPlaying(null);
      toast.error(`Couldn't play “${ref.file.name}”`, { description: errorText(error) });
    });
  }, []);

  const toggle = useCallback(
    (ref: SampleRef) => (playing === sampleKey(ref) ? stop() : play(ref)),
    [playing, play, stop],
  );

  const setVolume = useCallback((next: number) => {
    const value = Math.min(1, Math.max(0, next));
    volumeRef.current = value;
    setVolumeState(value);
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      // Not remembered, still applied.
    }
    void setSamplePreviewVolume(value).catch(() => {});
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void onSamplePreviewEnded(({ folderId, rel }) => {
      setPlaying((now) => (now === `${folderId}/${rel}` ? null : now));
    }).then((off) => {
      if (gone) off();
      else unlisten = off;
    });
    return () => {
      gone = true;
      unlisten?.();
      // Leaving the panel ends the audition.
      void stopSamplePreview().catch(() => {});
    };
  }, []);

  return { playing, volume, play, stop, toggle, setVolume };
}
