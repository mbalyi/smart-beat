import { useRef, useState, type PointerEvent } from "react";

import { newId } from "@/lib/audio-lanes/model";
import {
  dragNotes,
  hitNote,
  isBlackKey,
  msAt,
  noteBox,
  notesInRect,
  pitchAt,
  xOf,
  type NoteDrag,
  type View,
} from "@/lib/midi-editor/geometry";
import type { GridLine } from "@/lib/midi-editor/grid-lines";
import { sortNotes } from "@/lib/audio-lanes/midi";
import type { MidiNote } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** What a press on the grid does. */
export type Tool = "draw" | "select" | "erase";

/** How notes are drawn: bars, or hits (triangles or diamonds) on a drum grid. */
export type NoteShape = "bar" | "triangle" | "diamond";

/** Pixels the pointer travels before a press becomes a drag. */
const DRAG_PX = 3;

type Press =
  | { kind: "create"; note: MidiNote; x: number; y: number }
  | {
      kind: "drag";
      part: "body" | "end" | "top";
      ids: string[];
      x: number;
      y: number;
      moved: boolean;
    }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: "erase"; erased: Set<string> };

/**
 * The note grid of the MIDI editor: rows of pitches (shaded black keys, or drum rows), bar, beat
 * and grid lines, and the notes, coloured by velocity. Draw a note by pressing on an empty spot
 * (drag to set its length), drag a note to move it, its right edge to change its length, its top
 * edge to change its velocity, or drag a box around notes to select them. Double-click a note to
 * delete it, or an empty spot to add one. Changes are one step for Undo, made on release.
 */
export function PianoRoll({
  view,
  width,
  notes,
  ghost,
  selected,
  clipStartMs,
  clipMs,
  lines,
  tool,
  shape,
  color,
  defaultLenMs,
  snap,
  onSelect,
  onChange,
  onAudition,
  onPointerTime,
}: {
  view: View;
  width: number;
  notes: readonly MidiNote[];
  /** Notes shown faint (the quantize preview's starting point), not editable. */
  ghost?: readonly MidiNote[];
  selected: ReadonlySet<string>;
  clipStartMs: number;
  clipMs: number;
  lines: readonly GridLine[];
  tool: Tool;
  shape: NoteShape;
  color: string;
  defaultLenMs: number;
  /** Snaps a timeline point to the grid (or leaves it when snap is off). */
  snap: (ms: number) => number;
  onSelect: (ids: string[], add: boolean) => void;
  onChange: (notes: MidiNote[]) => void;
  onAudition: (pitch: number, velocity: number) => void;
  /** The time and pitch under the pointer, for the readout. */
  onPointerTime?: (at: { ms: number; pitch: number | null } | null) => void;
}) {
  const press = useRef<Press | null>(null);
  const [preview, setPreview] = useState<MidiNote[] | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const height = view.rows.length * view.rowHeight;
  const shown = preview ?? notes;

  const local = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const clipMsAt = (x: number) =>
    Math.min(Math.max(0, snap(msAt(view, x)) - clipStartMs), Math.max(0, clipMs - 1));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const hit = hitNote(view, clipStartMs, notes, x, y);
    if (tool === "erase") {
      press.current = { kind: "erase", erased: new Set(hit ? [hit.id] : []) };
      if (hit) setPreview(notes.filter((n) => n.id !== hit.id));
      return;
    }
    if (hit) {
      const add = event.shiftKey || event.metaKey || event.ctrlKey;
      const ids = selected.has(hit.id) && !add ? [...selected] : [hit.id];
      if (!selected.has(hit.id) || add) onSelect([hit.id], add);
      const note = notes.find((n) => n.id === hit.id);
      if (note) onAudition(note.pitch, note.vel);
      press.current = { kind: "drag", part: hit.part, ids, x, y, moved: false };
      return;
    }
    if (tool === "select" || event.shiftKey) {
      press.current = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, add: event.shiftKey };
      return;
    }
    const pitch = pitchAt(view, y);
    if (pitch === null) return;
    const startMs = clipMsAt(x);
    const note: MidiNote = {
      id: newId(),
      startMs,
      lenMs: Math.min(defaultLenMs, clipMs - startMs),
      pitch,
      vel: 100,
      chan: 0,
    };
    onAudition(pitch, note.vel);
    press.current = { kind: "create", note, x, y };
    setPreview(sortNotes([...notes, note]));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const { x, y } = local(event);
    onPointerTime?.({ ms: msAt(view, x), pitch: pitchAt(view, y) });
    const p = press.current;
    if (!p) return;
    switch (p.kind) {
      case "erase": {
        const hit = hitNote(view, clipStartMs, notes, x, y);
        if (hit && !p.erased.has(hit.id)) {
          p.erased.add(hit.id);
          setPreview(notes.filter((n) => !p.erased.has(n.id)));
        }
        return;
      }
      case "create": {
        const end = clipMsAt(x);
        const lenMs = Math.max(defaultLenMs, end - p.note.startMs);
        setPreview(
          sortNotes([...notes, { ...p.note, lenMs: Math.min(lenMs, clipMs - p.note.startMs) }]),
        );
        return;
      }
      case "marquee": {
        p.x1 = x;
        p.y1 = y;
        setMarquee({ x0: p.x0, y0: p.y0, x1: x, y1: y });
        return;
      }
      case "drag": {
        if (!p.moved && Math.hypot(x - p.x, y - p.y) < DRAG_PX) return;
        p.moved = true;
        setPreview(dragNotes(notes, dragOf(p, x, y), view.rows, clipMs));
        return;
      }
    }
  };

  const dragOf = (p: Extract<Press, { kind: "drag" }>, x: number, y: number): NoteDrag => {
    const deltaMs = snap(msAt(view, x)) - snap(msAt(view, p.x));
    if (p.part === "end") return { kind: "resize", ids: p.ids, deltaMs };
    if (p.part === "top") return { kind: "velocity", ids: p.ids, delta: (p.y - y) * 1.5 };
    return {
      kind: "move",
      ids: p.ids,
      deltaMs,
      deltaRows: Math.round((y - p.y) / view.rowHeight),
    };
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    const result = preview;
    setPreview(null);
    setMarquee(null);
    if (!p) return;
    if (p.kind === "marquee") {
      const ids = notesInRect(view, clipStartMs, notes, p);
      onSelect(ids, p.add);
      return;
    }
    if (p.kind === "drag" && !p.moved) return;
    if (result) {
      if (p.kind === "create") onSelect([p.note.id], false);
      if (p.kind === "drag") {
        const moved = result.find((n) => n.id === p.ids[0]);
        if (moved && p.part === "body") onAudition(moved.pitch, moved.vel);
      }
      onChange(result);
    }
    void event;
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const hit = hitNote(view, clipStartMs, notes, x, y);
    if (hit) onChange(notes.filter((n) => n.id !== hit.id));
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a drawing surface: pointer edits here, and the editor's keys (arrows, Delete, F1 to F12) act on the selection
    <div
      role="application"
      aria-label="Note grid"
      data-testid="piano-roll"
      className={cn(
        "relative touch-none select-none",
        tool === "draw" && "cursor-crosshair",
        tool === "erase" && "cursor-not-allowed",
      )}
      style={{ width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => onPointerTime?.(null)}
      onPointerCancel={() => {
        press.current = null;
        setPreview(null);
        setMarquee(null);
      }}
      onDoubleClick={onDoubleClick}
    >
      <RowShading view={view} width={width} />
      {/* Outside the clip is shaded: notes live inside it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 bg-foreground/5"
        style={{ width: Math.max(0, xOf(view, clipStartMs)) }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 bg-foreground/5"
        style={{ left: xOf(view, clipStartMs + clipMs) }}
      />
      {lines.map((line) => (
        <div
          key={`${line.kind}-${line.ms}`}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 w-px",
            line.kind === "bar" && "bg-foreground/35",
            line.kind === "beat" && "bg-foreground/15",
            line.kind === "grid" && "bg-foreground/[0.07]",
          )}
          style={{ left: xOf(view, line.ms) }}
        />
      ))}
      {ghost?.map((n) => {
        const box = noteBox(view, clipStartMs, n);
        return (
          box && (
            <div
              key={`ghost-${n.id}`}
              aria-hidden="true"
              className="pointer-events-none absolute rounded-sm border border-dashed border-foreground/40"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            />
          )
        );
      })}
      {shown.map((n) => (
        <NoteMark
          key={n.id}
          note={n}
          view={view}
          clipStartMs={clipStartMs}
          selected={selected.has(n.id)}
          shape={shape}
          color={color}
        />
      ))}
      {marquee && (
        <div
          aria-hidden="true"
          data-testid="midi-marquee"
          className="pointer-events-none absolute border border-primary bg-primary/15"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
    </div>
  );
}

/** Black-key rows (or every other drum row) shaded, so the eye can follow a row. */
function RowShading({ view, width }: { view: View; width: number }) {
  const piano = view.rows.length === 128;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ width }}>
      {view.rows.map((pitch, i) =>
        (piano ? isBlackKey(pitch) : i % 2 === 1) ? (
          <div
            key={pitch}
            className="absolute inset-x-0 bg-foreground/[0.045]"
            style={{ top: i * view.rowHeight, height: view.rowHeight }}
          />
        ) : piano && pitch % 12 === 0 ? (
          <div
            key={pitch}
            className="absolute inset-x-0 border-b border-foreground/15"
            style={{ top: i * view.rowHeight, height: view.rowHeight }}
          />
        ) : null,
      )}
    </div>
  );
}

function NoteMark({
  note,
  view,
  clipStartMs,
  selected,
  shape,
  color,
}: {
  note: MidiNote;
  view: View;
  clipStartMs: number;
  selected: boolean;
  shape: NoteShape;
  color: string;
}) {
  const box = noteBox(view, clipStartMs, note);
  if (!box) return null;
  const strength = 35 + (note.vel / 127) * 65;
  const hit = shape !== "bar";
  const size = Math.max(6, box.h - 2);
  return (
    <div
      data-testid={`midi-note-${note.id}`}
      data-selected={selected || undefined}
      data-pitch={note.pitch}
      title={`Velocity ${note.vel}`}
      className={cn(
        "pointer-events-none absolute border",
        shape === "bar" && "rounded-sm",
        selected ? "border-primary ring-2 ring-primary/60" : "border-foreground/30",
        note.muted && "opacity-40",
      )}
      style={{
        left: box.x,
        top: box.y + 1,
        width: hit ? size : box.w,
        height: hit ? size : box.h - 2,
        backgroundColor: `color-mix(in oklch, ${color} ${strength}%, var(--background))`,
        clipPath:
          shape === "triangle"
            ? "polygon(0 0, 100% 50%, 0 100%)"
            : shape === "diamond"
              ? "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)"
              : undefined,
      }}
    />
  );
}
