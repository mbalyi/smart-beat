import { MinusIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { ClipProperties } from "@/components/audio-lanes/clip-properties";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { Button } from "@/components/ui/button";
import { activeTake } from "@/lib/audio-lanes/model";
import {
  FIELD_LIMITS,
  editClips,
  selectedClips,
  setFadeLength,
  setFadeShape,
  setFlag,
  setNumber,
  summarizeClips,
  type EditMode,
  type FadeEnd,
  type FlagField,
  type NumberField,
  type Shared,
} from "@/lib/audio-lanes/multi-edit";
import { clipPeaks, normalizeGainDb } from "@/lib/audio-lanes/peaks";
import type { AudioClip, AudioLanesSettings, FadeShape } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The longest fade the panel offers, in ms (each clip still keeps its fades within itself). */
const MAX_FADE_MS = 60_000;

const SHAPES: { value: FadeShape; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "equalPower", label: "Equal power" },
  { value: "sCurve", label: "S-curve" },
];

const MODES: { value: EditMode; label: string }[] = [
  { value: "absolute", label: "Absolute" },
  { value: "relative", label: "Relative" },
];

const FLAGS: { field: FlagField; label: string }[] = [
  { field: "mute", label: "Mute" },
  { field: "locked", label: "Lock" },
  { field: "reversed", label: "Reverse" },
  { field: "preservePitch", label: "Keep pitch" },
];

const PITCH_FIELDS: { field: NumberField; label: string; step: number; unit?: string }[] = [
  { field: "gainDb", label: "Gain", step: 0.5, unit: "dB" },
  { field: "semitones", label: "Semitones", step: 1 },
  { field: "cents", label: "Cents", step: 1 },
];

const shownNumber = (value: number) => String(Number(value.toFixed(2)));

/**
 * A number typed in and committed on Enter or when the field loses focus, so each change is one
 * undo step. A mixed value shows an empty field with "Mixed" until a value is typed.
 */
function BatchNumber({
  label,
  value,
  relative = false,
  min,
  max,
  step,
  unit,
  describedBy,
  onCommit,
}: {
  label: string;
  value: Shared<number>;
  relative?: boolean;
  min: number;
  max: number;
  step: number;
  unit?: string;
  describedBy?: string;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const span = max - min;
  const shown = draft ?? (relative || value.mixed ? "" : shownNumber(value.value));
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const typed = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(typed)) onCommit(typed);
  };
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        {relative ? `${label} change` : label}
      </label>
      <span className="flex items-center gap-1">
        <input
          id={id}
          type="number"
          value={shown}
          placeholder={relative ? "+0" : value.mixed ? "Mixed" : undefined}
          min={relative ? -span : min}
          max={relative ? span : max}
          step={step}
          aria-describedby={describedBy}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          onBlur={commit}
          className="h-7 w-20 rounded-md border bg-background px-1.5 text-right tabular-nums placeholder:text-muted-foreground placeholder:italic"
        />
        <span className="w-6 text-xs text-muted-foreground">{unit}</span>
      </span>
    </div>
  );
}

function FadeFields({
  label,
  length,
  shape,
  mixedNote,
  onLength,
  onShape,
}: {
  label: string;
  length: Shared<number>;
  shape: Shared<FadeShape>;
  mixedNote: string;
  onLength: (ms: number) => void;
  onShape: (shape: FadeShape) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <BatchNumber
        label={label}
        value={length}
        min={0}
        max={MAX_FADE_MS}
        step={5}
        unit="ms"
        describedBy={length.mixed ? mixedNote : undefined}
        onCommit={(ms) => onLength(Math.min(MAX_FADE_MS, Math.max(0, ms)))}
      />
      <div className="flex items-center justify-between gap-2 text-sm">
        <label htmlFor={id} className="text-muted-foreground">
          {label} curve
        </label>
        <select
          id={id}
          value={shape.mixed ? "" : shape.value}
          aria-describedby={shape.mixed ? mixedNote : undefined}
          onChange={(e) => onShape(e.target.value as FadeShape)}
          className="h-7 rounded-md border bg-background px-1.5"
        >
          {shape.mixed && (
            <option value="" disabled>
              Mixed
            </option>
          )}
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** An on/off button for every clip: pressed, not pressed, or mixed (a dash, dashed outline). */
function BatchToggle({
  label,
  value,
  mixedNote,
  onChange,
}: {
  label: string;
  value: Shared<boolean>;
  mixedNote: string;
  onChange: (on: boolean) => void;
}) {
  const on = !value.mixed && value.value;
  return (
    <Button
      variant={on ? "default" : "outline"}
      size="sm"
      aria-pressed={value.mixed ? "mixed" : on}
      aria-describedby={value.mixed ? mixedNote : undefined}
      className={cn(value.mixed && "border-dashed border-foreground/50")}
      onClick={() => onChange(!on)}
    >
      {value.mixed && <MinusIcon aria-hidden="true" />}
      {label}
    </Button>
  );
}

function ModeChoice({
  mode,
  hint,
  onChange,
}: {
  mode: EditMode;
  hint: string;
  onChange: (mode: EditMode) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={hint}>
      <legend className="mb-1 text-xs font-medium text-muted-foreground">Gain and pitch</legend>
      <div className="grid grid-cols-2 rounded-md border p-0.5 text-sm">
        {MODES.map((m) => (
          <label
            key={m.value}
            className="cursor-pointer rounded px-2 py-1 text-center has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <input
              type="radio"
              name={name}
              value={m.value}
              checked={mode === m.value}
              onChange={() => onChange(m.value)}
              className="sr-only"
            />
            {m.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The shared settings of several selected clips: gain and pitch (set, or changed by an amount on
 * each clip), playrate, keep pitch, fades, mute, lock and reverse. A field the clips differ in shows
 * "Mixed" until it is changed; a change applies to every selected clip as one undo step.
 */
export function MultiClipProperties({
  lanes,
  clips,
}: {
  lanes: AudioLanesController;
  clips: readonly AudioClip[];
}) {
  const [mode, setMode] = useState<EditMode>("absolute");
  const [status, setStatus] = useState("");
  const mixedNote = useId();
  const modeHint = useId();
  const summary = useMemo(() => summarizeClips(clips), [clips]);
  const ids = useMemo(() => clips.map((c) => c.id), [clips]);
  const count = `${clips.length} clips`;
  const anyMixed = Object.values(summary).some((s: Shared<unknown>) => s.mixed);
  const canNormalize = clips.some((c) => lanes.infos.has(activeTake(c).sourceId));

  const edit = (message: string, fn: (audio: AudioLanesSettings) => AudioLanesSettings) => {
    lanes.apply(fn);
    setStatus(message);
  };
  const setField = (field: NumberField, label: string, fieldMode: EditMode, value: number) =>
    edit(
      fieldMode === "relative"
        ? `${label} changed by ${value > 0 ? "+" : ""}${value} on ${count}`
        : `${label} set to ${value} on ${count}`,
      (a) => setNumber(a, ids, field, fieldMode, value),
    );
  const fade = (end: FadeEnd, label: string) => ({
    onLength: (ms: number) =>
      edit(`${label} set to ${ms} ms on ${count}`, (a) => setFadeLength(a, ids, end, ms)),
    onShape: (shape: FadeShape) =>
      edit(`${label} curve set on ${count}`, (a) => setFadeShape(a, ids, end, shape)),
  });
  const normalize = () =>
    edit(`Normalized ${count}`, (a) =>
      editClips(a, ids, (clip) => {
        const info = lanes.infos.get(activeTake(clip).sourceId);
        return info ? { gainDb: normalizeGainDb(clipPeaks(clip, info), clip.gainDb) } : {};
      }),
    );

  return (
    <aside
      aria-label="Clip properties"
      data-testid="multi-clip-properties"
      tabIndex={-1}
      className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-card p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <h3 className="text-sm font-semibold">{count}</h3>
      {anyMixed && (
        <p id={mixedNote} className="text-xs text-muted-foreground">
          Mixed: the selected clips have different values. A change sets it on all of them.
        </p>
      )}
      <ModeChoice mode={mode} hint={modeHint} onChange={setMode} />
      <p id={modeHint} className="-mt-1.5 text-xs text-muted-foreground">
        {mode === "relative"
          ? "Relative adds the change to each clip's own value."
          : "Absolute gives every clip the same value."}
      </p>
      {PITCH_FIELDS.map(({ field, label, step, unit }) => {
        const value = summary[field];
        const { min, max } = FIELD_LIMITS[field];
        return (
          <BatchNumber
            key={`${field}-${mode}`}
            label={label}
            value={value}
            relative={mode === "relative"}
            min={min}
            max={max}
            step={step}
            unit={unit}
            describedBy={mode === "relative" ? modeHint : value.mixed ? mixedNote : undefined}
            onCommit={(v) => setField(field, label, mode, v)}
          />
        );
      })}
      <Section>
        <BatchNumber
          label="Playrate"
          value={summary.playrate}
          min={FIELD_LIMITS.playrate.min}
          max={FIELD_LIMITS.playrate.max}
          step={0.01}
          unit="×"
          describedBy={summary.playrate.mixed ? mixedNote : undefined}
          onCommit={(v) => setField("playrate", "Playrate", "absolute", v)}
        />
        <FadeFields
          label="Fade in"
          length={summary.fadeInMs}
          shape={summary.fadeInShape}
          mixedNote={mixedNote}
          {...fade("fadeIn", "Fade in")}
        />
        <FadeFields
          label="Fade out"
          length={summary.fadeOutMs}
          shape={summary.fadeOutShape}
          mixedNote={mixedNote}
          {...fade("fadeOut", "Fade out")}
        />
      </Section>
      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Clip switches">
        {FLAGS.map(({ field, label }) => (
          <BatchToggle
            key={field}
            label={label}
            value={summary[field]}
            mixedNote={mixedNote}
            onChange={(on) =>
              edit(`${label} ${on ? "on" : "off"} for ${count}`, (a) => setFlag(a, ids, field, on))
            }
          />
        ))}
      </div>
      <Button variant="outline" size="sm" disabled={!canNormalize} onClick={normalize}>
        Normalize each clip
      </Button>
      <p role="status" className="min-h-4 text-xs text-muted-foreground">
        {status}
      </p>
      <p className="border-t pt-2 text-xs text-muted-foreground">
        Select one clip to edit its name, takes, gain envelope and stretch markers.
      </p>
    </aside>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 border-t pt-3">{children}</div>;
}

/**
 * The properties panel for the selected clips: one clip's full settings, or the shared settings of
 * several. A new `focusRequest` (F2 or a double-click on a clip) moves the focus to the panel.
 */
export function SelectedClipsPanel({
  lanes,
  focusRequest = 0,
}: {
  lanes: AudioLanesController;
  focusRequest?: number;
}) {
  const clips = useMemo(
    () => selectedClips(lanes.audio, lanes.selection),
    [lanes.audio, lanes.selection],
  );
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusRequest > 0) box.current?.querySelector<HTMLElement>("aside")?.focus();
  }, [focusRequest]);
  if (clips.length === 0) return null;
  return (
    <div ref={box} className="contents">
      {clips.length === 1 ? (
        <ClipProperties lanes={lanes} clip={clips[0]!} />
      ) : (
        <MultiClipProperties lanes={lanes} clips={clips} />
      )}
    </div>
  );
}
