import { useCallback, useEffect, useMemo, useState } from "react";

import { effectiveTempo, readOverride, writeOverride, type TempoOverride } from "@/lib/stems/tempo";
import { detectStemTempo, type StemTempo } from "@/lib/tauri";

/** Finds the tempo of a song's stems, e.g. through the Rust command. */
export type DetectTempo = (id: string) => Promise<StemTempo>;

/**
 * The tempo of a separated song: the detector's answer (asked once when the page opens; Rust
 * keeps it, so a second time is quick) joined with what the user changed, which wins and is
 * remembered for the song. Never blocks playback: `finding` is true until the detector answers.
 */
export function useStemTempo(songId: string, detect: DetectTempo = detectStemTempo) {
  const [answer, setAnswer] = useState<{ id: string; tempo: StemTempo | null } | null>(null);
  useEffect(() => {
    let current = true;
    // A command that is missing or fails means "not found", not an error to show.
    void (async () => detect(songId))()
      .then(
        (tempo) => tempo ?? null,
        () => null,
      )
      .then((tempo) => {
        if (current) setAnswer({ id: songId, tempo });
      });
    return () => {
      current = false;
    };
  }, [songId, detect]);

  const [changed, setChanged] = useState<{ id: string; override: TempoOverride } | null>(null);
  const override = useMemo(
    () => (changed?.id === songId ? changed.override : readOverride(songId)),
    [changed, songId],
  );
  const change = useCallback(
    (patch: Partial<TempoOverride> | null) => {
      const next = patch === null ? {} : { ...readOverride(songId), ...patch };
      writeOverride(songId, next);
      setChanged({ id: songId, override: next });
    },
    [songId],
  );

  const finding = answer?.id !== songId;
  const detected = answer?.id === songId ? answer.tempo : null;
  const tempo = useMemo(() => effectiveTempo(detected, override), [detected, override]);
  return {
    finding,
    /** What the detector found; null while it works or when it found nothing. */
    detected,
    tempo,
    /** The user changed the tempo or the first beat. */
    changed: Object.keys(override).length > 0,
    setBpm: (bpm: number) => change({ bpm }),
    setFirstBeat: (seconds: number) => change({ firstBeatSec: Math.max(0, seconds) }),
    setFollowSections: (follow: boolean) => change({ followSections: follow }),
    /** Back to what was detected. */
    reset: () => change(null),
  };
}
