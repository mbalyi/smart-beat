import { useEffect, useState } from "react";

import { LabeledSlider } from "@/components/labeled-slider";
import { CheckRow, ChoiceGroup, MidiCard, MidiDialog } from "@/components/midi/midi-dialog";
import {
  DEFAULT_QUANTIZE,
  GRID_VALUES,
  SCALES,
  gridLabel,
  noteName,
  parsePitch,
  type GridType,
  type MidiGrid,
  type QuantizeOptions,
  type QuantizeTarget,
} from "@/lib/audio-lanes/midi-edit";
import type { MidiNote } from "@/lib/tauri";

const TARGETS: readonly { value: QuantizeTarget; label: string }[] = [
  { value: "start", label: "Note starts" },
  { value: "startEnd", label: "Starts and ends" },
  { value: "startLength", label: "Starts, keep lengths" },
  { value: "end", label: "Note ends" },
  { value: "length", label: "Lengths" },
];

const GRID_TYPES: readonly { value: GridType; label: string }[] = [
  { value: "straight", label: "Straight" },
  { value: "triplet", label: "Triplet" },
  { value: "dotted", label: "Dotted" },
  { value: "swing", label: "Swing" },
];

const percent = (v: number) => `${Math.round(v * 100)} %`;

/** Grid value and type pickers, shared by the editor's bottom bar and the quantize dialog. */
export function GridPicker({
  grid,
  onChange,
  compact,
}: {
  grid: MidiGrid;
  onChange: (grid: MidiGrid) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-sm">
        <span className={compact ? "sr-only" : undefined}>Grid</span>
        <select
          aria-label="Grid"
          className="h-8 rounded-md border bg-card px-2 text-sm"
          value={grid.value}
          onChange={(e) => onChange({ ...grid, value: Number(e.target.value) })}
        >
          {GRID_VALUES.map((v) => (
            <option key={v} value={v}>
              {gridLabel(v)}
            </option>
          ))}
        </select>
      </label>
      <select
        aria-label="Grid type"
        className="h-8 rounded-md border bg-card px-2 text-sm"
        value={grid.type}
        onChange={(e) => onChange({ ...grid, type: e.target.value as GridType })}
      >
        {GRID_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      {grid.type === "swing" && (
        <label className="flex items-center gap-1.5 text-sm">
          Swing
          <input
            type="number"
            aria-label="Swing amount (percent)"
            className="h-8 w-16 rounded-md border bg-card px-2 text-sm"
            min={-100}
            max={100}
            value={Math.round(grid.swing * 100)}
            onChange={(e) =>
              onChange({ ...grid, swing: Math.max(-1, Math.min(1, Number(e.target.value) / 100)) })
            }
          />
        </label>
      )}
    </div>
  );
}

/**
 * Quantize: move notes toward the grid, with strength, direction and range limits. The notes
 * keep how they were played, so "Unquantize" and another quantize start from the performance.
 * While open, the editor shows the result (`onPreview`); Bypass shows the notes as they are.
 */
export function QuantizeDialog({
  open,
  onOpenChange,
  grid: startGrid,
  selectedCount,
  onPreview,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grid: MidiGrid;
  /** Selected notes (0: every note of the clip). */
  selectedCount: number;
  onPreview: (preview: { options: QuantizeOptions; grid: MidiGrid } | null) => void;
  onApply: (options: QuantizeOptions, grid: MidiGrid) => void;
}) {
  const [options, setOptions] = useState<QuantizeOptions>(DEFAULT_QUANTIZE);
  const [grid, setGrid] = useState(startGrid);
  const [bypass, setBypass] = useState(false);
  const set = (patch: Partial<QuantizeOptions>) => setOptions((o) => ({ ...o, ...patch }));
  useEffect(() => {
    onPreview(open && !bypass ? { options, grid } : null);
  }, [open, bypass, options, grid, onPreview]);
  const scope = selectedCount > 0 ? `${selectedCount} selected notes` : "every note of the clip";
  return (
    <MidiDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onPreview(null);
        onOpenChange(next);
      }}
      title="Quantize"
      description={`Line up ${scope} with the grid. How you played stays saved, so you can always go back.`}
      action="Quantize"
      testId="quantize-dialog"
      onAction={() => {
        onApply(options, grid);
        onPreview(null);
        onOpenChange(false);
      }}
    >
      <MidiCard title="What moves">
        <ChoiceGroup
          label="What moves"
          value={options.target}
          options={TARGETS}
          onChange={(target) => set({ target })}
        />
      </MidiCard>
      <MidiCard title="Grid and strength">
        <GridPicker grid={grid} onChange={setGrid} />
        <LabeledSlider
          label="Strength"
          valueText={percent(options.strength)}
          value={options.strength}
          min={0}
          max={1}
          step={0.01}
          onValueChange={(strength) => set({ strength })}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm">
            Only notes this close to the grid: {percent(options.within[0])} to{" "}
            {percent(options.within[1])} of half a step
          </span>
          <div className="flex gap-3">
            <LabeledSlider
              label="From"
              valueText={percent(options.within[0])}
              value={options.within[0]}
              min={0}
              max={1}
              step={0.05}
              className="flex-1"
              onValueChange={(v) =>
                set({ within: [Math.min(v, options.within[1]), options.within[1]] })
              }
            />
            <LabeledSlider
              label="To"
              valueText={percent(options.within[1])}
              value={options.within[1]}
              min={0}
              max={1}
              step={0.05}
              className="flex-1"
              onValueChange={(v) =>
                set({ within: [options.within[0], Math.max(v, options.within[0])] })
              }
            />
          </div>
        </div>
      </MidiCard>
      <MidiCard title="Limits">
        <div className="grid grid-cols-2 gap-2">
          <CheckRow
            label="Move earlier"
            checked={options.moveLeft}
            onChange={(moveLeft) => set({ moveLeft })}
          />
          <CheckRow
            label="Move later"
            checked={options.moveRight}
            onChange={(moveRight) => set({ moveRight })}
          />
          <CheckRow
            label="Make shorter"
            checked={options.shrink}
            onChange={(shrink) => set({ shrink })}
          />
          <CheckRow label="Make longer" checked={options.grow} onChange={(grow) => set({ grow })} />
          <CheckRow
            label="Fix overlapping notes"
            checked={options.fixOverlaps}
            onChange={(fixOverlaps) => set({ fixOverlaps })}
          />
          <CheckRow label="Bypass (hear it as played)" checked={bypass} onChange={setBypass} />
        </div>
      </MidiCard>
    </MidiDialog>
  );
}

/** Humanize: small random changes to timing and velocity, so a part sounds less mechanical. */
export function HumanizeDialog({
  open,
  onOpenChange,
  selectedCount,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  onApply: (amount: { timingMs: number; velocity: number }) => void;
}) {
  const [timingMs, setTiming] = useState(10);
  const [velocity, setVelocity] = useState(8);
  const scope = selectedCount > 0 ? `${selectedCount} selected notes` : "every note of the clip";
  return (
    <MidiDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Humanize"
      description={`Nudge ${scope} a little off the grid and vary how hard they are played.`}
      action="Humanize"
      testId="humanize-dialog"
      onAction={() => {
        onApply({ timingMs, velocity });
        onOpenChange(false);
      }}
    >
      <MidiCard title="How much">
        <LabeledSlider
          label="Timing"
          valueText={`± ${timingMs} ms`}
          value={timingMs}
          min={0}
          max={50}
          step={1}
          onValueChange={setTiming}
        />
        <LabeledSlider
          label="Velocity"
          valueText={`± ${velocity}`}
          value={velocity}
          min={0}
          max={40}
          step={1}
          onValueChange={setVelocity}
        />
      </MidiCard>
    </MidiDialog>
  );
}

const SCALE_LABELS: Readonly<Record<string, string>> = {
  chromatic: "Chromatic",
  major: "Major",
  minor: "Minor",
  harmonicMinor: "Harmonic minor",
  dorian: "Dorian",
  mixolydian: "Mixolydian",
  pentatonicMajor: "Major pentatonic",
  pentatonicMinor: "Minor pentatonic",
  blues: "Blues",
};
const KEYS = Array.from({ length: 12 }, (_, i) => noteName(60 + i).replace(/\d+$/, ""));

/** Transpose: move notes by semitones or octaves, optionally keeping them in a scale. */
export function TransposeDialog({
  open,
  onOpenChange,
  selectedCount,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  onApply: (semitones: number, scale: { root: number; steps: readonly number[] } | null) => void;
}) {
  const [semitones, setSemitones] = useState(0);
  const [inScale, setInScale] = useState(false);
  const [root, setRoot] = useState(0);
  const [scale, setScale] = useState("major");
  const scope = selectedCount > 0 ? `${selectedCount} selected notes` : "every note of the clip";
  return (
    <MidiDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Transpose"
      description={`Move ${scope} up or down. Keep them in a key if you like.`}
      action="Transpose"
      testId="transpose-dialog"
      onAction={() => {
        onApply(semitones, inScale ? { root, steps: SCALES[scale] ?? SCALES.chromatic! } : null);
        onOpenChange(false);
      }}
    >
      <MidiCard title="How far">
        <LabeledSlider
          label="Semitones"
          valueText={`${semitones > 0 ? "+" : ""}${semitones}`}
          value={semitones}
          min={-24}
          max={24}
          step={1}
          onValueChange={setSemitones}
        />
        <ChoiceGroup
          label="Quick steps"
          value={String(semitones)}
          options={[
            { value: "-12", label: "Octave down" },
            { value: "0", label: "None" },
            { value: "12", label: "Octave up" },
          ]}
          onChange={(v) => setSemitones(Number(v))}
        />
      </MidiCard>
      <MidiCard title="Keep in a key">
        <CheckRow label="Snap the notes to a scale" checked={inScale} onChange={setInScale} />
        {inScale && (
          <div className="flex gap-2">
            <select
              aria-label="Key"
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={root}
              onChange={(e) => setRoot(Number(e.target.value))}
            >
              {KEYS.map((k, i) => (
                <option key={k} value={i}>
                  {k}
                </option>
              ))}
            </select>
            <select
              aria-label="Scale"
              className="h-9 rounded-md border bg-card px-2 text-sm"
              value={scale}
              onChange={(e) => setScale(e.target.value)}
            >
              {Object.keys(SCALES).map((s) => (
                <option key={s} value={s}>
                  {SCALE_LABELS[s] ?? s}
                </option>
              ))}
            </select>
          </div>
        )}
      </MidiCard>
    </MidiDialog>
  );
}

/** What the note properties dialog changes (unset: leave each note's own value). */
export interface NoteChanges {
  pitch?: (current: number) => number | null;
  vel?: number;
  chan?: number;
  lenMs?: number;
  startMs?: number;
}

/**
 * Note properties for one or more notes: pitch (a name like C4, a number, or relative such as
 * +1o2), velocity, channel, length and start. Empty fields keep each note's own value.
 */
export function NotePropertiesDialog({
  open,
  onOpenChange,
  notes,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: readonly MidiNote[];
  onApply: (changes: NoteChanges) => void;
}) {
  const first = notes[0];
  const one = notes.length === 1;
  const [pitch, setPitch] = useState("");
  const [vel, setVel] = useState("");
  const [chan, setChan] = useState("");
  const [len, setLen] = useState("");
  const [start, setStart] = useState("");
  // The fields start from the note each time the dialog opens (state set during render).
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = open ? notes.map((n) => n.id).join(",") : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (key !== null) {
      setPitch(one && first ? noteName(first.pitch) : "");
      setVel(one && first ? String(first.vel) : "");
      setChan(one && first ? String(first.chan + 1) : "");
      setLen(one && first ? String(Math.round(first.lenMs)) : "");
      setStart(one && first ? String(Math.round(first.startMs)) : "");
    }
  }
  const pitchOk = pitch.trim() === "" || parsePitch(pitch, first?.pitch ?? 60) !== null;
  const number = (text: string, min: number, max: number) => {
    if (text.trim() === "") return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
  };
  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string,
    invalid = false,
  ) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        className="h-9 rounded-md border bg-card px-2 text-sm aria-invalid:border-destructive"
        value={value}
        aria-invalid={invalid}
        placeholder={one ? undefined : "Keep each note's value"}
        onChange={(e) => set(e.target.value)}
      />
      <span className="text-xs text-muted-foreground">{hint}</span>
    </label>
  );
  return (
    <MidiDialog
      open={open}
      onOpenChange={onOpenChange}
      title={one ? "Note properties" : `Properties of ${notes.length} notes`}
      description="Change where a note starts, how long it is, its pitch, velocity and channel."
      action="Apply"
      actionDisabled={!pitchOk || notes.length === 0}
      testId="note-properties-dialog"
      onAction={() => {
        const text = pitch.trim();
        onApply({
          ...(text && { pitch: (current: number) => parsePitch(text, current) }),
          vel: number(vel, 1, 127),
          chan: chan.trim() ? Math.round(number(chan, 1, 16)! - 1) : undefined,
          lenMs: number(len, 1, 86_400_000),
          startMs: number(start, 0, 86_400_000),
        });
        onOpenChange(false);
      }}
    >
      <MidiCard title="Note">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field("Pitch", pitch, setPitch, "C4, F#2, 60, or +12 / -1o2 to move", !pitchOk)}
          {field("Velocity", vel, setVel, "1 to 127")}
          {field("Channel", chan, setChan, "1 to 16 (drums are 10)")}
          {field("Length (ms)", len, setLen, "How long the note sounds")}
          {one && field("Start (ms)", start, setStart, "From the start of the clip")}
        </div>
      </MidiCard>
    </MidiDialog>
  );
}
