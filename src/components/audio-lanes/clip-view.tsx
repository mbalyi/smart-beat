import { Link2Icon } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { ClipHandles, type ClipEdits } from "@/components/audio-lanes/clip-handles";
import { groupHue } from "@/lib/audio-lanes/clip-groups";
import { activeTake, clipEndMs } from "@/lib/audio-lanes/model";
import { clipPeaks } from "@/lib/audio-lanes/peaks";
import { clickMode, type ClickMode } from "@/lib/audio-lanes/selection";
import { slippedClip } from "@/lib/audio-lanes/slip";
import { waveformPath } from "@/lib/stems/waveform";
import type { AudioClip, SourceInfo } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Pixels a pointer must travel before a press on a clip becomes a drag. */
const DRAG_PX = 3;
/** Width of the trim handles at each edge of a clip. */
const EDGE_PX = 6;

export type ClipDrag =
  | { kind: "move"; clipId: string; startMs: number; laneId: string | null }
  | { kind: "trim"; clipId: string; edge: "start" | "end"; atMs: number }
  /** ⌘/Ctrl-drag: a copy lands at `startMs`; the clip stays. */
  | { kind: "copy"; clipId: string; startMs: number; laneId: string | null }
  /** ⌥/Alt-drag: the audio slides `deltaMs` inside the clip; the clip stays. */
  | { kind: "slip"; clipId: string; deltaMs: number };

/** The colour every clip of a group shares (its outline and link mark). */
const groupColor = (groupId: string) => `oklch(0.72 0.16 ${groupHue(groupId)})`;

/** A grouped clip: the group's outline, and a hint of its tint over the lane colour. */
const groupStyle = (groupId: string) => ({
  outlineColor: groupColor(groupId),
  backgroundImage: `linear-gradient(color-mix(in oklch, ${groupColor(groupId)} 14%, transparent), transparent)`,
});

/**
 * A clip on a lane: its waveform in the lane colour, its name, fades and a mute or lock mark (and
 * a link mark with its group's outline when it is grouped). It is a button (focus, Enter, arrows,
 * Delete), and it can be dragged along the lane or to another lane, and trimmed at its edges.
 * Positions go through `toX` and `toMs` (bars in the track list, time in the studio view).
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
  edits,
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
  /**
   * A press on the clip: select it alone, toggle it (⌘/Ctrl) or select a range (Shift). `alone`
   * (⌥) means just this clip, not the rest of its group.
   */
  onSelect: (mode: ClickMode, alone: boolean) => void;
  onDrop: (drag: ClipDrag) => void;
  onKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onOpen: () => void;
  /** A click (not a drag) on the clip puts the edit cursor there. */
  onCursor?: (ms: number) => void;
  /** Lane edits for the fade and volume handles (none: no handles). */
  edits?: ClipEdits;
}) {
  const [preview, setPreview] = useState<ClipDrag | null>(null);
  const press = useRef<{
    x: number;
    y: number;
    mode: "move" | "copy" | "slip" | "start" | "end";
    dragging: boolean;
  } | null>(null);
  const travels = preview?.kind === "move" || preview?.kind === "copy";
  const left = toX(
    travels
      ? preview.startMs
      : preview?.kind === "trim" && preview.edge === "start"
        ? preview.atMs
        : clip.startMs,
  );
  const right = toX(
    preview?.kind === "trim" && preview.edge === "end"
      ? preview.atMs
      : clipEndMs(clip) + (travels ? preview.startMs - clip.startMs : 0),
  );
  // A short clip stays big enough to grab and to reach by touch (24 px).
  const width = Math.max(24, right - left);
  const heard =
    preview?.kind === "slip" ? slippedClip(clip, preview.deltaMs, info?.durationMs) : clip;
  const peaks = useMemo(() => clipPeaks(heard, info), [heard, info]);
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
      : event.altKey
        ? "slip"
        : event.metaKey || event.ctrlKey
          ? "copy"
          : offset < EDGE_PX
            ? "start"
            : offset > box.width - EDGE_PX
              ? "end"
              : "move";
    press.current = { x: event.clientX, y: event.clientY, mode, dragging: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSelect(clickMode(event), event.altKey);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || clip.locked) return;
    const dx = event.clientX - p.x;
    if (!p.dragging && Math.hypot(dx, event.clientY - p.y) < DRAG_PX) return;
    p.dragging = true;
    if (p.mode === "slip") {
      setPreview({
        kind: "slip",
        clipId: clip.id,
        deltaMs: toMs(toX(clip.startMs) + dx) - clip.startMs,
      });
    } else if (p.mode === "move" || p.mode === "copy") {
      const target = document
        .elementFromPoint?.(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-lane-id]");
      const startMs = snap(toMs(toX(clip.startMs) + dx));
      setPreview({
        kind: p.mode,
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

  // Tabbing to a clip selects it, so its handles (fades and volume) are the next stops.
  const selectOnKeyboardFocus = (event: FocusEvent<HTMLButtonElement>) => {
    if (selected || press.current) return;
    let keyboard = false;
    try {
      keyboard = event.currentTarget.matches(":focus-visible");
    } catch {
      // No :focus-visible here (an old engine): a click selects instead.
    }
    if (keyboard) onSelect("single", false);
  };

  const button = (
    <button
      type="button"
      data-testid={`clip-${clip.id}`}
      data-clip-id={clip.id}
      data-drag={preview?.kind}
      aria-pressed={selected}
      aria-label={`${name} on ${laneName}${clip.groupId ? ", grouped" : ""}${clip.mute ? ", muted" : ""}${clip.locked ? ", locked" : ""}${missing ? ", file missing" : ""}`}
      data-group-id={clip.groupId}
      title={missing ? `“${name}” cannot be found` : name}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        press.current = null;
        setPreview(null);
      }}
      onDoubleClick={onOpen}
      onFocus={selectOnKeyboardFocus}
      onKeyDown={onKey}
      className={cn(
        "absolute inset-y-1 flex overflow-hidden rounded-md border text-left transition-shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
        selected ? "ring-2 ring-primary" : "",
        preview && "z-30 shadow-lg",
        clip.mute && "opacity-40",
        missing && "border-dashed",
        !clip.locked && "cursor-grab active:cursor-grabbing",
        preview?.kind === "copy" && "cursor-copy overflow-visible active:cursor-copy",
        preview?.kind === "slip" && "cursor-ew-resize active:cursor-ew-resize",
        clip.groupId && "outline-2 outline-offset-1 outline-dashed",
      )}
      style={{
        left,
        width,
        borderColor: color,
        backgroundColor: `color-mix(in oklch, ${color} 22%, transparent)`,
        ...(clip.groupId && groupStyle(clip.groupId)),
      }}
    >
      {clip.groupId && (
        <Link2Icon
          aria-hidden="true"
          data-testid="clip-group-mark"
          className="pointer-events-none absolute top-0.5 right-1 z-10 size-3"
          style={{ color: groupColor(clip.groupId) }}
        />
      )}
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
      {selected && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-primary/20" />
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
      {preview?.kind === "copy" && (
        <CopyMarks ghostLeft={toX(clip.startMs) - left} ghostWidth={width} color={color} />
      )}
    </button>
  );
  return (
    <>
      {button}
      {/* Only on the selected clip: small targets on every clip would crowd the lane. */}
      {edits && selected && (
        <ClipHandles {...{ clip, name, left, width, toX, toMs, edits, compact }} />
      )}
    </>
  );
}

/**
 * A copy being dragged: a "+" badge on it, and a dashed outline where the original stays
 * (`ghostLeft` from the copy's left edge).
 */
function CopyMarks({
  ghostLeft,
  ghostWidth,
  color,
}: {
  ghostLeft: number;
  ghostWidth: number;
  color: string;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        data-testid="clip-copy-ghost"
        className="pointer-events-none absolute -inset-y-px rounded-md border border-dashed"
        style={{ left: ghostLeft, width: ghostWidth, borderColor: color }}
      />
      <span
        aria-hidden="true"
        data-testid="clip-copy-badge"
        className="pointer-events-none absolute top-0.5 right-0.5 z-20 grid size-4 place-items-center rounded-full bg-foreground text-[11px] leading-none font-bold text-background"
      >
        +
      </span>
    </>
  );
}
