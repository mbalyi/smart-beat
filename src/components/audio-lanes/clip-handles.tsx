import { CheckIcon } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { updateClip } from "@/lib/audio-lanes/edits";
import {
  FADE_SHAPE_LABELS,
  HANDLE_MIN_CLIP_PX,
  clampGainDb,
  fadeHandleX,
  fadeKeyMs,
  fadeLengthPatch,
  fadeMsAtX,
  fadeOf,
  fadeShapePatch,
  fadeWidthPx,
  formatFadeMs,
  formatGainDb,
  gainAfterDrag,
  gainKeyDb,
  maxFadeMs,
  removeFadePatch,
  type FadeEdge,
} from "@/lib/audio-lanes/handles";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "@/lib/audio-lanes/model";
import type { AudioClip, FadeShape } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The lane edits the handles make: one undo step per drag, key or menu choice. */
export type ClipEdits = Pick<AudioLanesController, "apply" | "applyQuiet" | "beginGesture">;

/** The size (px) of a fade handle's grab area. */
const FADE_HANDLE_PX = 14;

interface HandleProps {
  clip: AudioClip;
  name: string;
  edits: ClipEdits;
}

/** Changes a clip as one undo step. */
const editClip = (edits: ClipEdits, clipId: string, patch: Partial<AudioClip>) =>
  edits.apply((a) => updateClip(a, clipId, patch));

/**
 * A drag that edits a clip as one undo step. The step starts with the first real change, so a
 * press that does not move leaves no empty step behind.
 */
function useClipGesture(edits: ClipEdits, clipId: string) {
  const started = useRef(false);
  return {
    start: () => {
      started.current = false;
    },
    change: (patch: Partial<AudioClip>) => {
      if (!started.current) {
        started.current = true;
        edits.beginGesture();
      }
      edits.applyQuiet((a) => updateClip(a, clipId, patch));
    },
  };
}

/** Keeps a handle's events from reaching the clip and the lane under it. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

/** The value a handle shows while it is hovered, focused or dragged. */
function HandleLabel({
  text,
  active,
  className,
}: {
  text: string;
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-40 rounded bg-popover px-1 py-px text-[10px] leading-3 font-medium whitespace-nowrap text-popover-foreground tabular-nums opacity-0 shadow-sm ring-1 ring-foreground/10 transition-opacity group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 motion-reduce:transition-none",
        active && "opacity-100",
        className,
      )}
    >
      {text}
    </span>
  );
}

/**
 * The top edge of a clip: drag it up or down to change the clip's volume (Shift for fine steps),
 * double-click it for 0 dB. A vertical slider for the keyboard.
 */
function GainHandle({ clip, name, edits }: HandleProps) {
  const gesture = useClipGesture(edits, clip.id);
  const drag = useRef<{ y: number; db: number } | null>(null);
  const [active, setActive] = useState(false);
  const text = formatGainDb(clip.gainDb);
  const set = (gainDb: number) => {
    if (gainDb !== clip.gainDb) editClip(edits, clip.id, { gainDb });
  };

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    stop(event);
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { y: event.clientY, db: clip.gainDb };
    gesture.start();
    setActive(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    // Step by step, so Shift can be pressed or let go during the drag.
    d.db = gainAfterDrag(d.db, event.clientY - d.y, event.shiftKey);
    d.y = event.clientY;
    const gainDb = clampGainDb(d.db);
    if (gainDb !== clip.gainDb) gesture.change({ gainDb });
  };
  const end = () => {
    drag.current = null;
    setActive(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const next = gainKeyDb(clip.gainDb, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    stop(event);
    set(next);
  };

  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={`Volume of ${name}, ${text}`}
      aria-orientation="vertical"
      aria-valuemin={MIN_GAIN_DB}
      aria-valuemax={MAX_GAIN_DB}
      aria-valuenow={clip.gainDb}
      aria-valuetext={text}
      data-testid={`clip-gain-${clip.id}`}
      className="group/handle pointer-events-auto absolute inset-x-3.5 top-0 h-1.5 cursor-ns-resize touch-none outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={stop}
      onDoubleClick={(event) => {
        stop(event);
        set(0);
      }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full transition-colors group-hover/handle:bg-primary group-focus-visible/handle:bg-primary motion-reduce:transition-none",
          active ? "bg-primary" : clip.gainDb !== 0 ? "bg-primary/50" : "bg-transparent",
        )}
      />
      <HandleLabel text={text} active={active} className="top-1.5 left-1/2 -translate-x-1/2" />
    </span>
  );
}

/** The right-click menu of a fade handle: the fade's curve, and taking it away. */
function FadeMenu({
  clip,
  edge,
  label,
  edits,
}: {
  clip: AudioClip;
  edge: FadeEdge;
  label: string;
  edits: ClipEdits;
}) {
  const fade = fadeOf(clip, edge);
  const setShape = (shape: FadeShape) => {
    if (shape !== fade.shape) editClip(edits, clip.id, fadeShapePatch(clip, edge, shape));
  };
  return (
    <ContextMenuContent aria-label={`${label} shape`}>
      <ContextMenuLabel>
        {label} · {formatFadeMs(fade.ms)}
      </ContextMenuLabel>
      {FADE_SHAPE_LABELS.map((shape) => (
        <ContextMenuItem key={shape.value} onSelect={() => setShape(shape.value)}>
          <CheckIcon className={shape.value === fade.shape ? "" : "invisible"} />
          {shape.label}
          {shape.value === fade.shape && <span className="sr-only"> (current)</span>}
        </ContextMenuItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={fade.ms === 0}
        onSelect={() => editClip(edits, clip.id, removeFadePatch(edge))}
      >
        Remove fade
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/**
 * A fade handle at a top corner of a clip: drag it inward or outward to set the fade, ⌥-click to
 * take the fade away, right-click for its curve. A slider for the keyboard.
 */
function FadeHandle({
  clip,
  name,
  edits,
  edge,
  width,
  toX,
  toMs,
}: HandleProps & {
  edge: FadeEdge;
  width: number;
  toX: (ms: number) => number;
  toMs: (x: number) => number;
}) {
  const gesture = useClipGesture(edits, clip.id);
  const drag = useRef<{ x: number; handleX: number } | null>(null);
  const [active, setActive] = useState(false);
  const fade = fadeOf(clip, edge);
  const label = edge === "in" ? "Fade in" : "Fade out";
  const text = formatFadeMs(fade.ms);
  const inset = Math.min(
    Math.max(0, width - FADE_HANDLE_PX),
    Math.max(0, fadeWidthPx(clip, edge, toX) - FADE_HANDLE_PX / 2),
  );
  const remove = () => {
    if (fade.ms > 0) editClip(edits, clip.id, removeFadePatch(edge));
  };

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    stop(event);
    if (event.button !== 0) return;
    if (event.altKey) {
      remove();
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, handleX: fadeHandleX(clip, edge, toX) };
    gesture.start();
    setActive(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const ms = fadeMsAtX(clip, edge, d.handleX + event.clientX - d.x, toMs);
    if (ms !== fade.ms) gesture.change(fadeLengthPatch(clip, edge, ms));
  };
  const end = () => {
    drag.current = null;
    setActive(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const next =
      event.key === "Delete" || event.key === "Backspace"
        ? 0
        : fadeKeyMs(clip, edge, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    stop(event);
    if (next !== fade.ms) editClip(edits, clip.id, fadeLengthPatch(clip, edge, next));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={stop}>
        <span
          role="slider"
          tabIndex={0}
          aria-label={`${label} of ${name}, ${text}`}
          aria-valuemin={0}
          aria-valuemax={maxFadeMs(clip, edge)}
          aria-valuenow={fade.ms}
          aria-valuetext={text}
          data-testid={`clip-fade-${edge}-${clip.id}`}
          className="group/handle pointer-events-auto absolute top-0 z-10 flex cursor-ew-resize touch-none items-start outline-none"
          style={{
            width: FADE_HANDLE_PX,
            height: FADE_HANDLE_PX,
            [edge === "in" ? "left" : "right"]: inset,
            justifyContent: edge === "in" ? "flex-start" : "flex-end",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={end}
          onPointerCancel={end}
          onClick={stop}
          onDoubleClick={stop}
          onKeyDown={onKeyDown}
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none size-2.5 border border-foreground/60 bg-background shadow-sm transition-colors group-hover/handle:border-primary group-hover/handle:bg-primary group-focus-visible/handle:border-primary group-focus-visible/handle:bg-primary group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-ring/50 motion-reduce:transition-none",
              edge === "in" ? "rounded-br-sm" : "rounded-bl-sm",
              active && "border-primary bg-primary",
            )}
          />
          <HandleLabel
            text={text}
            active={active}
            className={cn("top-3.5", edge === "in" ? "left-0" : "right-0")}
          />
        </span>
      </ContextMenuTrigger>
      <FadeMenu clip={clip} edge={edge} label={label} edits={edits} />
    </ContextMenu>
  );
}

/**
 * Direct handles on a clip, laid over it (not inside its button): fade in and fade out at the top
 * corners and the volume along the top edge. A locked clip, or one too narrow to grab, has none.
 * `left` and `width` are where the clip is drawn now (px across the lane).
 */
export function ClipHandles({
  clip,
  name,
  left,
  width,
  toX,
  toMs,
  edits,
}: HandleProps & {
  left: number;
  width: number;
  toX: (ms: number) => number;
  toMs: (x: number) => number;
}) {
  if (clip.locked || width < HANDLE_MIN_CLIP_PX) return null;
  const shared = { clip, name, edits, width, toX, toMs };
  return (
    <div
      data-testid={`clip-handles-${clip.id}`}
      // A right-click on the volume edge opens the lane menu for this clip.
      data-clip-id={clip.id}
      className="pointer-events-none absolute inset-y-1 z-20"
      style={{ left, width }}
    >
      <GainHandle clip={clip} name={name} edits={edits} />
      <FadeHandle edge="in" {...shared} />
      <FadeHandle edge="out" {...shared} />
    </div>
  );
}
