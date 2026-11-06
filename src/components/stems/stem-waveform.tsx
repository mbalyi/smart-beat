import { useMemo, useRef, useState } from "react";

import { usePosition, useStemState } from "@/components/stems/use-stem-player";
import type { StemLoop, StemPlayer } from "@/lib/stems/player";
import { waveformPath } from "@/lib/stems/waveform";
import { cn } from "@/lib/utils";

/** How many bars a waveform has. */
const BUCKETS = 400;

/** A drag shorter than this many pixels is a click. */
const DRAG_PIXELS = 4;

/**
 * One stem's waveform, drawn from its decoded audio, with the playhead and the loop. A click
 * seeks and a drag sets the loop. The buttons and the Position slider do the same by keyboard,
 * so the picture is hidden from screen readers.
 */
export function StemWaveform({
  player,
  kind,
  duration,
  loop,
  quiet,
  onSeek,
  onLoop,
}: {
  player: StemPlayer;
  kind: Parameters<StemPlayer["peaks"]>[0];
  duration: number;
  loop: StemLoop | null;
  /** The stem is not heard (muted, or another one is soloed): drawn paler. */
  quiet: boolean;
  onSeek: (seconds: number) => void;
  onLoop: (loop: StemLoop) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<StemLoop | null>(null);
  const position = usePosition(player);
  // The stems are decoded after the page opens: draw them again once they are.
  const { loaded } = useStemState(player);
  const path = useMemo(
    () => waveformPath(player.peaks(kind, BUCKETS)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player, kind, loaded],
  );
  const shown = draft ?? loop;

  const fraction = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const percent = (seconds: number) => `${duration > 0 ? (seconds / duration) * 100 : 0}%`;

  return (
    <div
      ref={box}
      aria-hidden="true"
      data-testid={`waveform-${kind}`}
      className="relative h-14 w-full cursor-pointer touch-none overflow-hidden rounded-lg border bg-muted/40 select-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, moved: false };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        if (!start.moved && Math.abs(event.clientX - start.x) < DRAG_PIXELS) return;
        start.moved = true;
        const a = fraction(start.x) * duration;
        const b = fraction(event.clientX) * duration;
        setDraft({ start: Math.min(a, b), end: Math.max(a, b) });
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        drag.current = null;
        if (!start) return;
        if (start.moved) {
          const a = fraction(start.x) * duration;
          const b = fraction(event.clientX) * duration;
          onLoop({ start: Math.min(a, b), end: Math.max(a, b) });
        } else {
          onSeek(fraction(event.clientX) * duration);
        }
        setDraft(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDraft(null);
      }}
    >
      {shown && (
        <div
          className="absolute inset-y-0 bg-primary/25"
          style={{ left: percent(shown.start), width: percent(shown.end - shown.start) }}
        />
      )}
      <svg
        viewBox={`0 0 ${BUCKETS} 100`}
        preserveAspectRatio="none"
        className={cn(
          "absolute inset-0 size-full text-primary transition-opacity motion-reduce:transition-none",
          quiet && "opacity-30",
        )}
      >
        <path d={path} fill="currentColor" />
      </svg>
      <div
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground"
        style={{ left: percent(position) }}
      />
    </div>
  );
}
