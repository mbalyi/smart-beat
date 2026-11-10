import { useState } from "react";

import { clipPeaks, normalizeGainDb } from "@/lib/audio-lanes/peaks";
import { RemoveSilenceDialog } from "@/components/audio-lanes/remove-silence-dialog";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { chooseTake, findClip, updateClip } from "@/lib/audio-lanes/edits";
import {
  MAX_CENTS,
  MAX_GAIN_DB,
  MAX_PLAYRATE,
  MAX_SEMITONES,
  MIN_GAIN_DB,
  MIN_PLAYRATE,
  activeTake,
  clipEndMs,
} from "@/lib/audio-lanes/model";
import type { AudioClip, ClipFade, FadeShape } from "@/lib/tauri";

const SHAPES: { value: FadeShape; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "equalPower", label: "Equal power" },
  { value: "sCurve", label: "S-curve" },
];

function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          aria-label={label}
          value={Number(value.toFixed(2))}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = e.currentTarget.valueAsNumber;
            if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
          className="h-7 w-20 rounded-md border bg-background px-1.5 text-right tabular-nums"
        />
        {unit && <span className="w-6 text-xs text-muted-foreground">{unit}</span>}
      </span>
    </label>
  );
}

function FadeField({
  label,
  fade,
  onChange,
}: {
  label: string;
  fade: ClipFade;
  onChange: (fade: ClipFade) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <NumberField
        label={label}
        value={fade.ms}
        min={0}
        max={60_000}
        step={5}
        unit="ms"
        onChange={(ms) => onChange({ ...fade, ms })}
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Curve</span>
        <select
          value={fade.shape}
          onChange={(e) => onChange({ ...fade, shape: e.target.value as FadeShape })}
          className="h-7 rounded-md border bg-background px-1.5"
        >
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The selected clip's settings in the studio: gain and normalize, pitch, playrate, fades, mute,
 * lock and reverse, its takes, its gain envelope and stretch markers at the edit cursor.
 */
export function ClipProperties({ lanes, clip }: { lanes: AudioLanesController; clip: AudioClip }) {
  const { apply, editCursorMs } = lanes;
  const set = (patch: Partial<AudioClip>) => apply((a) => updateClip(a, clip.id, patch));
  const info = lanes.infos.get(activeTake(clip).sourceId);
  const inside = editCursorMs > clip.startMs && editCursorMs < clipEndMs(clip);
  const at = inside ? (editCursorMs - clip.startMs) / (clipEndMs(clip) - clip.startMs) : null;
  const [silenceOpen, setSilenceOpen] = useState(false);
  return (
    <aside
      aria-label="Clip properties"
      data-testid="clip-properties"
      className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-card p-3"
    >
      <h3 className="truncate text-sm font-semibold">{activeTake(clip).name}</h3>
      <NumberField
        label="Gain"
        value={clip.gainDb}
        min={MIN_GAIN_DB}
        max={MAX_GAIN_DB}
        step={0.5}
        unit="dB"
        onChange={(gainDb) => set({ gainDb })}
      />
      <NumberField
        label="Semitones"
        value={clip.semitones}
        min={-MAX_SEMITONES}
        max={MAX_SEMITONES}
        step={1}
        onChange={(semitones) => set({ semitones: Math.round(semitones) })}
      />
      <NumberField
        label="Cents"
        value={clip.cents}
        min={-MAX_CENTS}
        max={MAX_CENTS}
        step={1}
        onChange={(cents) => set({ cents: Math.round(cents) })}
      />
      <NumberField
        label="Playrate"
        value={clip.playrate}
        min={MIN_PLAYRATE}
        max={MAX_PLAYRATE}
        step={0.01}
        unit="×"
        onChange={(playrate) => set({ playrate })}
      />
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Keep the pitch</span>
        <Switch
          checked={clip.preservePitch}
          onCheckedChange={(preservePitch) => set({ preservePitch })}
          aria-label="Keep the pitch when the playrate changes"
        />
      </div>
      <FadeField label="Fade in" fade={clip.fadeIn} onChange={(fadeIn) => set({ fadeIn })} />
      <FadeField label="Fade out" fade={clip.fadeOut} onChange={(fadeOut) => set({ fadeOut })} />
      <div className="grid grid-cols-3 gap-1.5">
        {(["mute", "locked", "reversed"] as const).map((field) => (
          <Button
            key={field}
            variant={clip[field] ? "default" : "outline"}
            size="sm"
            aria-pressed={clip[field]}
            onClick={() => set({ [field]: !clip[field] })}
          >
            {field === "mute" ? "Mute" : field === "locked" ? "Lock" : "Reverse"}
          </Button>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!info}
        onClick={() => set({ gainDb: normalizeGainDb(clipPeaks(clip, info), clip.gainDb) })}
      >
        Normalize
      </Button>
      <Button variant="outline" size="sm" onClick={() => setSilenceOpen(true)}>
        Remove silence…
      </Button>
      <RemoveSilenceDialog
        open={silenceOpen}
        onOpenChange={setSilenceOpen}
        lanes={lanes}
        clipIds={lanes.selection.includes(clip.id) ? lanes.selection : [clip.id]}
      />
      {clip.takes.length > 1 && (
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">Take</span>
          <select
            value={clip.take}
            onChange={(e) => apply((a) => chooseTake(a, clip.id, Number(e.target.value)))}
            className="h-7 rounded-md border bg-background px-1.5"
          >
            {clip.takes.map((t, i) => (
              <option key={i} value={i}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-col gap-1.5 border-t pt-2">
        <p className="text-xs text-muted-foreground">
          Gain envelope ({clip.envelope.length} points) and stretch markers ({clip.stretch.length}),
          at the edit cursor
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={at === null}
            onClick={() => at !== null && set({ envelope: [...clip.envelope, { at, db: 0 }] })}
          >
            Add gain point
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!clip.envelope.length}
            onClick={() => set({ envelope: [] })}
          >
            Clear gain
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={at === null}
            onClick={() => {
              if (at === null) return;
              const clipMs = editCursorMs - clip.startMs;
              apply((a) => {
                const found = findClip(a, clip.id);
                if (!found) return a;
                const sourceMs = clipMs * found.clip.playrate;
                return updateClip(a, clip.id, {
                  stretch: [...found.clip.stretch, { sourceMs, clipMs }],
                });
              });
            }}
          >
            Add stretch marker
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!clip.stretch.length}
            onClick={() => set({ stretch: [] })}
          >
            Clear markers
          </Button>
        </div>
        {clip.envelope.map((p, i) => (
          <NumberField
            key={i}
            label={`Point ${Math.round(p.at * 100)}%`}
            value={p.db}
            min={MIN_GAIN_DB}
            max={MAX_GAIN_DB}
            step={0.5}
            unit="dB"
            onChange={(db) =>
              set({ envelope: clip.envelope.map((q, j) => (j === i ? { ...q, db } : q)) })
            }
          />
        ))}
        {clip.stretch.map((m, i) => (
          <NumberField
            key={`s${i}`}
            label={`Marker at ${(m.clipMs / 1000).toFixed(2)} s plays`}
            value={m.sourceMs / 1000}
            min={0}
            max={clip.lengthMs / 1000}
            step={0.01}
            unit="s"
            onChange={(seconds) =>
              set({
                stretch: clip.stretch.map((q, j) =>
                  j === i ? { ...q, sourceMs: seconds * 1000 } : q,
                ),
              })
            }
          />
        ))}
      </div>
    </aside>
  );
}
