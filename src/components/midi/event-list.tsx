import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { controllerLabel, type ControllerKind } from "@/lib/midi-editor/controllers";
import { Button } from "@/components/ui/button";
import { noteName, parsePitch } from "@/lib/audio-lanes/midi-edit";
import type { MidiCc, MidiNote } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** One row of the list: a note or a controller event. */
type Row =
  | { type: "note"; at: number; note: MidiNote }
  | { type: "cc"; at: number; cc: MidiCc; index: number };

/** What a filter keeps. */
export type EventFilter = "all" | "notes" | "controllers";

const ccKind = (cc: MidiCc): ControllerKind =>
  cc.kind === "cc"
    ? { type: "cc", cc: cc.cc ?? 0 }
    : cc.kind === "program"
      ? { type: "cc", cc: -1 }
      : { type: cc.kind };

/**
 * Every event of the clip as a table: position, kind, channel and values. Notes can be changed
 * in place (pitch as C4 or a number, velocity, length), any row deleted, and a note added at the
 * position line. Click a note row to select the note.
 */
export function EventList({
  notes,
  cc,
  selected,
  cursorMs,
  formatMs,
  onSelect,
  onNotes,
  onCc,
  onAdd,
}: {
  notes: readonly MidiNote[];
  cc: readonly MidiCc[];
  selected: ReadonlySet<string>;
  /** Where a new note goes (clip ms). */
  cursorMs: number;
  /** A clip time as bars and beats. */
  formatMs: (ms: number) => string;
  onSelect: (ids: string[], add: boolean) => void;
  onNotes: (notes: MidiNote[]) => void;
  onCc: (cc: MidiCc[]) => void;
  onAdd: (atMs: number) => void;
}) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const rows = useMemo(() => {
    const all: Row[] = [
      ...(filter === "controllers"
        ? []
        : notes.map((note) => ({ type: "note" as const, at: note.startMs, note }))),
      ...(filter === "notes"
        ? []
        : cc.map((c, index) => ({ type: "cc" as const, at: c.atMs, cc: c, index }))),
    ];
    return all.sort((a, b) => a.at - b.at);
  }, [notes, cc, filter]);
  const setNote = (id: string, patch: Partial<MidiNote>) =>
    onNotes(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="midi-event-list">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <label className="flex items-center gap-1.5 text-xs">
          Show
          <select
            aria-label="Show events"
            className="h-7 rounded-md border bg-card px-1.5 text-xs"
            value={filter}
            onChange={(e) => setFilter(e.target.value as EventFilter)}
          >
            <option value="all">Everything</option>
            <option value="notes">Notes</option>
            <option value="controllers">Controllers</option>
          </select>
        </label>
        <Button variant="outline" size="xs" onClick={() => onAdd(cursorMs)}>
          <PlusIcon aria-hidden="true" /> Add note
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={selected.size === 0}
          onClick={() => onNotes(notes.filter((n) => !selected.has(n.id)))}
        >
          <Trash2Icon aria-hidden="true" /> Delete selected
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{rows.length} events</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1 font-medium">Position</th>
              <th className="px-2 py-1 font-medium">Event</th>
              <th className="px-2 py-1 font-medium">Ch</th>
              <th className="px-2 py-1 font-medium">Value</th>
              <th className="px-2 py-1 font-medium">Velocity</th>
              <th className="px-2 py-1 font-medium">Length (ms)</th>
              <th className="px-2 py-1">
                <span className="sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.type === "note" ? (
                <tr
                  key={row.note.id}
                  aria-selected={selected.has(row.note.id)}
                  onClick={(e) => onSelect([row.note.id], e.shiftKey || e.metaKey || e.ctrlKey)}
                  className={cn("border-b", selected.has(row.note.id) && "bg-primary/15")}
                >
                  <td className="px-2 py-0.5 tabular-nums">{formatMs(row.at)}</td>
                  <td className="px-2 py-0.5">Note</td>
                  <td className="px-2 py-0.5">{row.note.chan + 1}</td>
                  <td className="px-2 py-0.5">
                    <CellInput
                      label={`Pitch of the note at ${formatMs(row.at)}`}
                      value={noteName(row.note.pitch)}
                      onCommit={(text) => {
                        const pitch = parsePitch(text, row.note.pitch);
                        if (pitch !== null) setNote(row.note.id, { pitch });
                      }}
                    />
                  </td>
                  <td className="px-2 py-0.5">
                    <CellInput
                      label={`Velocity of the note at ${formatMs(row.at)}`}
                      value={String(row.note.vel)}
                      onCommit={(text) => {
                        const vel = Number(text);
                        if (Number.isFinite(vel))
                          setNote(row.note.id, {
                            vel: Math.min(127, Math.max(1, Math.round(vel))),
                          });
                      }}
                    />
                  </td>
                  <td className="px-2 py-0.5">
                    <CellInput
                      label={`Length of the note at ${formatMs(row.at)}`}
                      value={String(Math.round(row.note.lenMs))}
                      onCommit={(text) => {
                        const lenMs = Number(text);
                        if (Number.isFinite(lenMs) && lenMs > 0) setNote(row.note.id, { lenMs });
                      }}
                    />
                  </td>
                  <td className="px-2 py-0.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete the note at ${formatMs(row.at)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onNotes(notes.filter((n) => n.id !== row.note.id));
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </td>
                </tr>
              ) : (
                <tr key={`cc-${row.index}`} className="border-b text-muted-foreground">
                  <td className="px-2 py-0.5 tabular-nums">{formatMs(row.at)}</td>
                  <td className="px-2 py-0.5">
                    {row.cc.kind === "program" ? "Program change" : controllerLabel(ccKind(row.cc))}
                  </td>
                  <td className="px-2 py-0.5">{row.cc.chan + 1}</td>
                  <td className="px-2 py-0.5 tabular-nums">{row.cc.value}</td>
                  <td />
                  <td />
                  <td className="px-2 py-0.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete the controller event at ${formatMs(row.at)}`}
                      onClick={() => onCc(cc.filter((_, i) => i !== row.index))}
                    >
                      <Trash2Icon />
                    </Button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="p-4 text-center text-sm text-muted-foreground">
            No events yet. Draw notes in the piano roll, record, or add a note here.
          </p>
        )}
      </div>
    </div>
  );
}

/** A table cell value that is changed on Enter or when it loses the focus. */
function CellInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  // Escape throws the change away: the blur that follows must not keep it.
  const cancelled = useRef(false);
  return (
    <input
      aria-label={label}
      className="h-6 w-16 rounded border border-transparent bg-transparent px-1 hover:border-border focus:border-ring focus:outline-none"
      value={text ?? value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!cancelled.current && text !== null && text !== value) onCommit(text);
        cancelled.current = false;
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
