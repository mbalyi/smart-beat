import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { activeTake, clipEndMs } from "@/lib/audio-lanes/model";
import { clipPeaks } from "@/lib/audio-lanes/peaks";
import { waveformPath } from "@/lib/stems/waveform";
import type { AudioClip, SourceInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Pixels a pointer must travel before a press on a clip becomes a drag. */
const DRAG_PX = 3;
/** Width of the trim handles at each edge of a clip. */
const EDGE_PX = 6;

export type ClipDrag =
  | { kind: "move"; clipId: string; startMs: number; laneId: string | null }
  | { kind: "trim"; clipId: string; edge: "start" | "end"; atMs: number };

/**
 * A clip on a lane: its waveform in the lane colour, its name, fades and a mute or lock mark. It
 * is a button (focus, Enter, arrows, Delete), and it can be dragged along the lane or to another
 * lane, and trimmed at its edges. Positions go through `toX` and `toMs` (bars in the track list,
 * time in the studio view).
 */
export function ClipView({
  clip,
  laneName,
  color,
  info,
  missing,
  selected,
  toX,
  toMs,
  snap,
  compact,
  onSelect,
  onDrop,
  onKey,
  onOpen,
  onCursor,
}: {
  clip: AudioClip;
  laneName: string;
  color: string;
  info: SourceInfo | undefined;
  missing: boolean;
  selected: boolean;
  toX: (ms: number) => number;
  toMs: (x: number) => number;
  snap: (ms: number) => number;
  /** Short rows (the track list): no title line. */
  compact?: boolean;
  onSelect: (additive: boolean) => void;
  onDrop: (drag: ClipDrag) => void;
  onKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onOpen: () => void;
  /** A click (not a drag) on the clip puts the edit cursor there. */
  onCursor?: (ms: number) => void;
}) {
  const [preview, setPreview] = useState<ClipDrag | null>(null);
  const press = useRef<{
    x: number;
    y: number;
    mode: "move" | "start" | "end";
    dragging: boolean;
  } | null>(null);
  const left = toX(
    preview?.kind === "move"
      ? preview.startMs
      : preview?.kind === "trim" && preview.edge === "start"
        ? preview.atMs
        : clip.startMs,
  );
  const right = toX(
    preview?.kind === "trim" && preview.edge === "end"
      ? preview.atMs
      : clipEndMs(clip) + (preview?.kind === "move" ? preview.startMs - clip.startMs : 0),
  );
  // A short clip stays big enough to grab and to reach by touch (24 px).
  const width = Math.max(24, right - left);
  const peaks = useMemo(() => clipPeaks(clip, info), [clip, info]);
  const path = useMemo(() => (peaks.length ? waveformPath(peaks) : ""), [peaks]);
  const name = activeTake(clip).name;
  const fadeIn =
    clip.fadeIn.ms > 0
      ? Math.min(width, toX(clip.startMs + clip.fadeIn.ms / clip.playrate) - toX(clip.startMs))
      : 0;
  const fadeOut =
    clip.fadeOut.ms > 0
      ? Math.min(
          width,
          toX(clipEndMs(clip)) - toX(clipEndMs(clip) - clip.fadeOut.ms / clip.playrate),
        )
      : 0;

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - box.left;
    const mode = clip.locked
      ? "move"
      : offset < EDGE_PX
        ? "start"
        : offset > box.width - EDGE_PX
          ? "end"
          : "move";
    press.current = { x: event.clientX, y: event.clientY, mode, dragging: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSelect(event.shiftKey || event.metaKey);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || clip.locked) return;
    const dx = event.clientX - p.x;
    if (!p.dragging && Math.hypot(dx, event.clientY - p.y) < DRAG_PX) return;
    p.dragging = true;
    if (p.mode === "move") {
      const target = document
        .elementFromPoint?.(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-lane-id]");
      const startMs = snap(toMs(toX(clip.startMs) + dx));
      setPreview({
        kind: "move",
        clipId: clip.id,
        startMs,
        laneId: target?.dataset.laneId ?? null,
      });
    } else {
      const edgeMs = p.mode === "start" ? clip.startMs : clipEndMs(clip);
      setPreview({
        kind: "trim",
        clipId: clip.id,
        edge: p.mode,
        atMs: snap(toMs(toX(edgeMs) + dx)),
      });
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const done = preview;
    const p = press.current;
    press.current = null;
    setPreview(null);
    // WebKit (the macOS app) does not focus a button it was clicked on, and takes the focus away
    // after the press: focus the clip at the end of the click, so its keys work.
    event.currentTarget.focus({ preventScroll: true });
    if (done) onDrop(done);
    else if (p && !p.dragging && onCursor) {
      const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
      onCursor(snap(toMs(left + x)));
    }
  };

  return (
    <button
      type="button"
      data-testid={`clip-${clip.id}`}
      data-clip-id={clip.id}
      aria-pressed={selected}
      aria-label={`${name} on ${laneName}${clip.mute ? ", muted" : ""}${clip.locked ? ", locked" : ""}${missing ? ", file missing" : ""}`}
      title={missing ? `“${name}” cannot be found` : name}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        press.current = null;
        setPreview(null);
      }}
      onDoubleClick={onOpen}
      onKeyDown={onKey}
      className={cn(
        "absolute inset-y-1 flex overflow-hidden rounded-md border text-left transition-shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
        selected ? "ring-2 ring-foreground" : "",
        preview && "z-30 shadow-lg",
        clip.mute && "opacity-40",
        missing && "border-dashed",
        !clip.locked && "cursor-grab active:cursor-grabbing",
      )}
      style={{
        left,
        width,
        borderColor: color,
        backgroundColor: `color-mix(in oklch, ${color} 22%, transparent)`,
      }}
    >
      {!compact && (
        <span className="pointer-events-none absolute top-0.5 left-1.5 z-10 max-w-full truncate text-[10px] leading-3 font-medium">
          {name}
          {clip.semitones || clip.cents
            ? ` · ${clip.semitones >= 0 ? "+" : ""}${clip.semitones} st`
            : ""}
        </span>
      )}
      {path && (
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${peaks.length} 100`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full"
          style={{ color }}
        >
          <path d={path} fill="currentColor" />
        </svg>
      )}
      {missing && (
        <span className="pointer-events-none m-auto text-[10px] text-muted-foreground">
          File missing
        </span>
      )}
      {fadeIn > 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 bg-background/40 [clip-path:polygon(0_0,100%_0,0_100%)]"
          style={{ width: fadeIn }}
        />
      )}
      {fadeOut > 1 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 bg-background/40 [clip-path:polygon(0_0,100%_0,100%_100%)]"
          style={{ width: fadeOut }}
        />
      )}
    </button>
  );
}
