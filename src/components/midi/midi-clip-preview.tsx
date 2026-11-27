import { useMemo } from "react";

import { activeMidiTake } from "@/lib/audio-lanes/midi";
import type { AudioClip } from "@/lib/tauri";

/** Notes drawn at most (a dense clip still draws quickly). */
const MAX_DRAWN = 4_000;

/**
 * A MIDI clip's notes as a small piano roll (ADR 0006): bars from the lowest to the highest
 * pitch it plays, or dots in rows for a drum or pad lane. Brighter notes are louder.
 */
export function MidiClipPreview({
  clip,
  color,
  drums = false,
}: {
  clip: AudioClip;
  color: string;
  drums?: boolean;
}) {
  const take = activeMidiTake(clip);
  const shapes = useMemo(() => {
    const notes = take.notes.slice(0, MAX_DRAWN);
    if (notes.length === 0 || clip.lengthMs <= 0) return null;
    const low = Math.min(...notes.map((n) => n.pitch));
    const high = Math.max(...notes.map((n) => n.pitch));
    const rows = Math.max(12, high - low + 1);
    const rowHeight = 100 / rows;
    return notes.map((n) => {
      const x = (n.startMs / clip.lengthMs) * 1000;
      const y = (high - n.pitch) * rowHeight + (rows - (high - low + 1)) * rowHeight * 0.5;
      const w = drums ? 6 : Math.max(3, (n.lenMs / clip.lengthMs) * 1000);
      return {
        id: n.id,
        x,
        y,
        w,
        h: Math.max(1.5, rowHeight * 0.8),
        o: 0.45 + (n.vel / 127) * 0.55,
      };
    });
  }, [take, clip.lengthMs, drums]);
  if (!shapes) return null;
  return (
    <svg
      aria-hidden="true"
      data-testid="midi-clip-preview"
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 top-3 bottom-0.5 h-[calc(100%-0.875rem)] w-full"
      style={{ color }}
    >
      {shapes.map((s) => (
        <rect
          key={s.id}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={drums ? 3 : 0.8}
          fill="currentColor"
          fillOpacity={s.o}
        />
      ))}
    </svg>
  );
}
