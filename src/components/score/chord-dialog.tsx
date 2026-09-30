import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  autoFirstFret,
  DIAGRAM_FRETS,
  diagramPitches,
  recognizeChord,
  type ChordDiagram,
  type ChordName,
  type ChordSpec,
} from "@/lib/score/chords";
import { MAX_FRET, pitchName } from "@/lib/score/music";

/** A stringed track's strings, for the diagram editor. */
export interface ChordStrings {
  /** MIDI pitches, highest string first. */
  tuning: number[];
  capo: number;
}

const MUTED = -1;
const FRETS = Array.from({ length: MAX_FRET + 1 }, (_, fret) => fret);

/**
 * The diagram as guitarists read it: lowest string on the left, the nut (or
 * first fret) at the top. Click a fret to press it (again to lift it), or
 * above the nut to switch between open and not played. The per-string lists
 * below it do the same with the keyboard.
 */
function DiagramGrid({
  diagram,
  onChange,
}: {
  diagram: ChordDiagram;
  onChange: (diagram: ChordDiagram) => void;
}) {
  const count = diagram.strings.length;
  const cellW = 28;
  const cellH = 26;
  const left = 20;
  const top = 26;
  const width = left * 2 + cellW * (count - 1);
  const height = top + cellH * DIAGRAM_FRETS + 12;
  // Column 0 is the lowest string (the last entry of `strings`).
  const column = (index: number) => count - 1 - index;
  const set = (index: number, fret: number) =>
    onChange({ ...diagram, strings: diagram.strings.map((f, i) => (i === index ? fret : f)) });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="w-44 self-center select-none"
    >
      <text x={2} y={top + cellH / 2 + 4} className="fill-muted-foreground text-[10px]">
        {diagram.firstFret > 1 ? diagram.firstFret : ""}
      </text>
      {Array.from({ length: DIAGRAM_FRETS + 1 }, (_, row) => (
        <line
          key={row}
          x1={left}
          x2={left + cellW * (count - 1)}
          y1={top + row * cellH}
          y2={top + row * cellH}
          className="stroke-foreground/60"
          strokeWidth={row === 0 && diagram.firstFret === 1 ? 4 : 1}
        />
      ))}
      {diagram.strings.map((fret, index) => {
        const x = left + column(index) * cellW;
        return (
          <g key={index}>
            <line
              x1={x}
              x2={x}
              y1={top}
              y2={top + cellH * DIAGRAM_FRETS}
              className="stroke-foreground/60"
            />
            <text
              x={x}
              y={top - 8}
              textAnchor="middle"
              className="cursor-pointer fill-foreground text-[12px]"
              onClick={() => set(index, fret === 0 ? MUTED : 0)}
            >
              {fret === MUTED ? "×" : fret === 0 ? "○" : ""}
            </text>
            {Array.from({ length: DIAGRAM_FRETS }, (_, row) => {
              const target = diagram.firstFret + row;
              return (
                <rect
                  key={row}
                  x={x - cellW / 2}
                  y={top + row * cellH}
                  width={cellW}
                  height={cellH}
                  className="cursor-pointer fill-transparent"
                  onClick={() => set(index, fret === target ? MUTED : target)}
                />
              );
            })}
            {fret > 0 && fret >= diagram.firstFret && fret < diagram.firstFret + DIAGRAM_FRETS && (
              <circle
                cx={x}
                cy={top + (fret - diagram.firstFret + 0.5) * cellH}
                r={8}
                className="pointer-events-none fill-sky-600 dark:fill-sky-400"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Chord names to pick from. Keeps its height when empty, so the diagram below doesn't jump. */
function Suggestions({
  label,
  names,
  onPick,
}: {
  label: string;
  names: ChordName[];
  onPick: (name: string) => void;
}) {
  return (
    <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-sm">
      {names.length > 0 && (
        <>
          <span className="text-muted-foreground">{label}</span>
          {names.slice(0, 4).map((chord) => (
            <Button
              key={chord.name}
              type="button"
              variant="secondary"
              size="xs"
              aria-label={`Name it ${chord.spoken}`}
              onClick={() => onPick(chord.name)}
            >
              {chord.name}
            </Button>
          ))}
        </>
      )}
    </div>
  );
}

function ChordForm({
  initial,
  strings,
  suggestions,
  notesDiagram,
  preferFlats,
  onSubmit,
  onCancel,
}: {
  initial: ChordSpec | null;
  strings: ChordStrings | null;
  suggestions: ChordName[];
  notesDiagram: ChordDiagram | null;
  preferFlats: boolean;
  onSubmit: (spec: ChordSpec | null) => void;
  onCancel: () => void;
}) {
  const ids = { name: useId(), firstFret: useId(), show: useId() };
  const [name, setName] = useState(initial?.name ?? suggestions[0]?.name ?? "");
  const emptyDiagram = (): ChordDiagram | null =>
    strings ? { strings: strings.tuning.map(() => MUTED), firstFret: 1 } : null;
  const [diagram, setDiagram] = useState<ChordDiagram | null>(
    () => initial?.diagram ?? notesDiagram ?? emptyDiagram(),
  );
  const [showDiagram, setShowDiagram] = useState(initial?.showDiagram ?? strings !== null);
  // Names for the diagram, unless the selected notes already gave them.
  const fromDiagram =
    diagram && strings
      ? recognizeChord(diagramPitches(diagram, strings.tuning, strings.capo), {
          preferFlats,
        }).filter((chord) => !suggestions.some((s) => s.name === chord.name))
      : [];

  const setFret = (index: number, fret: number) => {
    if (!diagram) return;
    const next = diagram.strings.map((f, i) => (i === index ? fret : f));
    // Keep the pressed frets in view.
    const fretted = next.filter((f) => f > 0);
    const outside = fretted.some(
      (f) => f < diagram.firstFret || f >= diagram.firstFret + DIAGRAM_FRETS,
    );
    setDiagram({ strings: next, firstFret: outside ? autoFirstFret(next) : diagram.firstFret });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({ name: trimmed, diagram, showDiagram: diagram !== null && showDiagram });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Chord</DialogTitle>
        <DialogDescription>
          {strings
            ? "The chord name is shown above the beat, its diagram at the top of the score."
            : "The chord name is shown above the beat."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.name} className="text-sm font-medium">
          Name
        </label>
        <Input
          id={ids.name}
          value={name}
          maxLength={20}
          required
          placeholder="e.g. Am7"
          onChange={(e) => setName(e.target.value)}
        />
        <Suggestions label="Selected notes:" names={suggestions} onPick={setName} />
        <Suggestions label="Diagram:" names={fromDiagram} onPick={setName} />
      </div>

      {diagram && strings && (
        <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-semibold">Diagram</legend>
          <div className="flex items-center gap-2">
            <Checkbox
              id={ids.show}
              checked={showDiagram}
              onCheckedChange={(value) => setShowDiagram(value === true)}
            />
            <label htmlFor={ids.show} className="text-sm">
              Show the diagram
            </label>
          </div>
          <DiagramGrid
            diagram={diagram}
            onChange={(next) =>
              setDiagram({
                ...next,
                firstFret: next.strings.some(
                  (f) => f > 0 && (f < next.firstFret || f >= next.firstFret + DIAGRAM_FRETS),
                )
                  ? autoFirstFret(next.strings)
                  : next.firstFret,
              })
            }
          />
          <div className="flex items-center gap-2">
            <label htmlFor={ids.firstFret} className="text-sm">
              First fret shown
            </label>
            <Input
              id={ids.firstFret}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_FRET}
              className="h-8 w-20"
              value={diagram.firstFret}
              onChange={(e) =>
                setDiagram({
                  ...diagram,
                  firstFret: Math.min(MAX_FRET, Math.max(1, Number(e.target.value) || 1)),
                })
              }
            />
          </div>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Strings">
            {diagram.strings.map((fret, index) => {
              const open = strings.tuning[index]!;
              const label = `String ${index + 1} (${pitchName(open, { octave: false, spoken: true })})`;
              return (
                <li key={index} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground" aria-hidden="true">
                    {index + 1}: {pitchName(open, { octave: false })}
                  </span>
                  <Select
                    value={String(fret)}
                    onValueChange={(value) => setFret(index, Number(value))}
                  >
                    <SelectTrigger size="sm" className="w-full" aria-label={label}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={String(MUTED)}>Not played</SelectItem>
                      {FRETS.map((f) => (
                        <SelectItem key={f} value={String(f)}>
                          {f === 0 ? "Open" : `Fret ${f}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-2">
            {notesDiagram && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDiagram(notesDiagram)}
              >
                Use the notes at the cursor
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDiagram(emptyDiagram())}
            >
              Clear
            </Button>
          </div>
        </fieldset>
      )}

      <DialogFooter>
        {initial && (
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            onClick={() => onSubmit(null)}
          >
            Remove chord
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim()}>
          Apply
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * A chord on the beat at the edit cursor: its name (suggested from the
 * selected notes, or from the diagram) and, on tab tracks, its diagram.
 */
export function ChordDialog({
  open,
  onOpenChange,
  initial,
  strings,
  suggestions,
  notesDiagram,
  preferFlats,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ChordSpec | null;
  /** The track's strings, or null for tracks without (name only). */
  strings: ChordStrings | null;
  /** Names for the notes at the cursor or in the selection. */
  suggestions: ChordName[];
  /** The notes at the cursor as a diagram (tab tracks), to start from. */
  notesDiagram: ChordDiagram | null;
  /** The key has flats: name chords with flats. */
  preferFlats: boolean;
  /** The chord, or null to remove it. */
  onSubmit: (spec: ChordSpec | null) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ChordForm
          initial={initial}
          strings={strings}
          suggestions={suggestions}
          notesDiagram={notesDiagram}
          preferFlats={preferFlats}
          onSubmit={(spec) => {
            onSubmit(spec);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
