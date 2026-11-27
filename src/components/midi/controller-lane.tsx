import { useRef, useState, type PointerEvent } from "react";

import { sortCc } from "@/lib/audio-lanes/midi";
import { controllerLabel, inLane, type ControllerKind } from "@/lib/midi-editor/controllers";
import { msAt, xOf, type View } from "@/lib/midi-editor/geometry";
import type { MidiCc, MidiNote } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const range = (kind: ControllerKind): [number, number] =>
  kind.type === "bend" ? [-8192, 8191] : [0, 127];

/** A point drawn closer than this to another (ms) replaces it. */
const SAME_MS = 5;

/**
 * A lane under the notes for velocity or a controller. Drag across the velocity lane to paint
 * the velocities of the notes there; drag across a controller lane to draw its values (one point
 * per grid step), and ⌥/Alt-click a point to delete it. One undo step on release.
 */
export function ControllerLane({
  kind,
  view,
  width,
  height,
  clipStartMs,
  notes,
  cc,
  selected,
  channel,
  snap,
  color,
  onNotes,
  onCc,
}: {
  kind: ControllerKind;
  view: View;
  width: number;
  height: number;
  clipStartMs: number;
  notes: readonly MidiNote[];
  cc: readonly MidiCc[];
  selected: ReadonlySet<string>;
  /** The channel new controller points get. */
  channel: number;
  snap: (ms: number) => number;
  color: string;
  onNotes: (notes: MidiNote[]) => void;
  onCc: (cc: MidiCc[]) => void;
}) {
  const [low, high] = range(kind);
  const [draft, setDraft] = useState<{ notes?: MidiNote[]; cc?: MidiCc[] } | null>(null);
  const drawing = useRef(false);
  const valueAt = (y: number) =>
    Math.round(low + (1 - Math.min(1, Math.max(0, y / height))) * (high - low));
  const yOf = (value: number) => (1 - (value - low) / (high - low)) * height;
  const shownNotes = draft?.notes ?? notes;
  const shownCc = draft?.cc ?? cc;
  const points = shownCc.filter((c) => inLane(kind, c));

  const paint = (x: number, y: number) => {
    const value = valueAt(y);
    if (kind.type === "velocity") {
      const base = draft?.notes ?? notes;
      // The notes whose start is within a few pixels; only the selection when there is one.
      const touched = base.filter(
        (n) =>
          Math.abs(xOf(view, clipStartMs + n.startMs) - x) <= 4 &&
          (selected.size === 0 || selected.has(n.id)),
      );
      if (touched.length === 0) return;
      const ids = new Set(touched.map((n) => n.id));
      setDraft({ notes: base.map((n) => (ids.has(n.id) ? { ...n, vel: Math.max(1, value) } : n)) });
      return;
    }
    const atMs = Math.max(0, snap(msAt(view, x)) - clipStartMs);
    const base = draft?.cc ?? cc;
    const point: MidiCc = {
      atMs,
      kind: kind.type === "cc" ? "cc" : kind.type,
      ...(kind.type === "cc" && { cc: kind.cc }),
      value,
      chan: channel,
    };
    setDraft({
      cc: sortCc([
        ...base.filter((c) => !(inLane(kind, c) && Math.abs(c.atMs - atMs) < SAME_MS)),
        point,
      ]),
    });
  };

  const local = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    if (event.altKey && kind.type !== "velocity") {
      const near = points.find((c) => Math.abs(xOf(view, clipStartMs + c.atMs) - x) <= 5);
      if (near) onCc(cc.filter((c) => c !== near));
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawing.current = true;
    paint(x, y);
  };

  return (
    <div
      role="application"
      aria-label={`${controllerLabel(kind)} lane`}
      data-testid={`controller-lane-${kind.type}`}
      className="relative touch-none border-t bg-card/60 select-none"
      style={{ width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (!drawing.current) return;
        const { x, y } = local(event);
        paint(x, y);
      }}
      onPointerUp={() => {
        drawing.current = false;
        if (draft?.notes) onNotes(draft.notes);
        if (draft?.cc) onCc(draft.cc);
        setDraft(null);
      }}
    >
      {kind.type === "bend" && (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 h-px bg-foreground/25"
          style={{ top: yOf(0) }}
        />
      )}
      {kind.type === "velocity"
        ? shownNotes.map((n) => (
            <div
              key={n.id}
              aria-hidden="true"
              data-testid={`velocity-${n.id}`}
              className={cn(
                "pointer-events-none absolute bottom-0 w-1 rounded-t-sm",
                selected.has(n.id) && "outline outline-primary",
              )}
              style={{
                left: xOf(view, clipStartMs + n.startMs),
                height: (n.vel / 127) * height,
                backgroundColor: color,
              }}
            />
          ))
        : points.map((c, i) => {
            const next = points[i + 1];
            const x = xOf(view, clipStartMs + c.atMs);
            return (
              <div
                key={`${c.atMs}-${i}`}
                aria-hidden="true"
                data-testid="controller-point"
                className="pointer-events-none absolute"
                style={{ left: x, top: yOf(c.value) }}
              >
                <span
                  className="absolute -top-1 -left-1 size-2 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {/* A step to the next point: controllers hold their value until they change. */}
                <span
                  className="absolute top-0 left-0 h-px"
                  style={{
                    width: next ? xOf(view, clipStartMs + next.atMs) - x : width - x,
                    backgroundColor: color,
                  }}
                />
              </div>
            );
          })}
    </div>
  );
}
