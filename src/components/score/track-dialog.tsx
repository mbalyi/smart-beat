import { useId, useState, type FormEvent, type ReactNode } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DrumMapping } from "@/lib/score/instrument-view";
import {
  describeStaffLine,
  getPreset,
  GM_FAMILIES,
  GM_INSTRUMENTS,
  INSTRUMENT_PRESETS,
  MAX_CAPO,
  MAX_STRINGS,
  MIN_STRINGS,
  pitchName,
  resizeTuning,
  tuningName,
  tuningPresets,
  type TrackKind,
} from "@/lib/score/music";

/** What the dialog produces. */
export interface TrackSettings {
  /** Add mode: the preset picked. */
  presetId?: string;
  kind: TrackKind;
  name: string;
  program: number;
  tuning: number[];
  capo: number;
}

const CUSTOM = "custom";

function Field({ label, children, id }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Up/down controls for each string's pitch, highest string first. */
function TuningEditor({
  tuning,
  onChange,
}: {
  tuning: number[];
  onChange: (tuning: number[]) => void;
}) {
  const change = (index: number, step: number) =>
    onChange(
      tuning.map((pitch, i) => (i === index ? Math.min(96, Math.max(12, pitch + step)) : pitch)),
    );
  return (
    <ol className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4" aria-label="Strings">
      {tuning.map((pitch, index) => (
        <li key={index} className="flex items-center gap-1 text-sm">
          <span className="w-5 text-muted-foreground tabular-nums">{index + 1}</span>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => change(index, -1)}
            aria-label={`Lower string ${index + 1}`}
          >
            <MinusIcon />
          </Button>
          <output
            className="w-9 text-center font-medium tabular-nums"
            aria-label={`String ${index + 1}`}
            aria-live="polite"
          >
            {pitchName(pitch)}
          </output>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => change(index, 1)}
            aria-label={`Raise string ${index + 1}`}
          >
            <PlusIcon />
          </Button>
        </li>
      ))}
    </ol>
  );
}

function DrumKitTable({ kit }: { kit: DrumMapping[] }) {
  return (
    <div
      className="max-h-56 overflow-auto rounded-md border"
      tabIndex={0}
      role="region"
      aria-label="Drum kit"
    >
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Where each drum sound is written on the staff</caption>
        <thead className="sticky top-0 bg-muted text-xs text-foreground">
          <tr>
            <th scope="col" className="px-2 py-1 font-medium">
              Sound
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              MIDI
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Staff position
            </th>
            <th scope="col" className="px-2 py-1 font-medium">
              Notehead
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {kit.map((row) => (
            <tr key={`${row.name}-${row.midi}`}>
              <th scope="row" className="px-2 py-1 font-normal">
                {row.name}
              </th>
              <td className="px-2 py-1 tabular-nums">{row.midi}</td>
              <td className="px-2 py-1">{describeStaffLine(row.staffLine)}</td>
              <td className="px-2 py-1">{row.notehead}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const settingsFromPreset = (presetId: string): TrackSettings => {
  const preset = getPreset(presetId) ?? INSTRUMENT_PRESETS[0]!;
  return {
    presetId: preset.id,
    kind: preset.kind,
    name: preset.name,
    program: preset.program,
    tuning: [...(preset.tuning ?? [])],
    capo: 0,
  };
};

/** The form; mounted each time the dialog opens, so it starts from `initial`. */
function TrackForm({
  initial,
  drumKit,
  onSubmit,
  onCancel,
}: {
  initial: TrackSettings | null;
  drumKit: DrumMapping[];
  onSubmit: (settings: TrackSettings) => void;
  onCancel: () => void;
}) {
  const ids = {
    preset: useId(),
    name: useId(),
    program: useId(),
    strings: useId(),
    tuning: useId(),
    capo: useId(),
  };
  const [settings, setSettings] = useState<TrackSettings>(
    () => initial ?? settingsFromPreset("guitar"),
  );
  const adding = initial === null;
  const set = (change: Partial<TrackSettings>) => setSettings((s) => ({ ...s, ...change }));
  const { kind, tuning } = settings;
  const presetName = tuningName(tuning);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ ...settings, name: settings.name.trim() || "Track" });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{adding ? "Add track" : "Track settings"}</DialogTitle>
        <DialogDescription>
          {adding
            ? "Choose an instrument. Its sound, tuning and capo can be changed later too."
            : kind === "stringed"
              ? "Changing the tuning keeps the fret numbers; the notes follow the new pitches."
              : kind === "drums"
                ? "Drum tracks use the standard Guitar Pro drum-kit notation."
                : "Written on a staff, in any General MIDI sound."}
        </DialogDescription>
      </DialogHeader>

      {adding && (
        <Field label="Instrument" id={ids.preset}>
          <Select
            value={settings.presetId}
            onValueChange={(presetId) => setSettings(settingsFromPreset(presetId))}
          >
            <SelectTrigger id={ids.preset} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INSTRUMENT_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Name" id={ids.name}>
        <Input
          id={ids.name}
          value={settings.name}
          maxLength={60}
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>

      {kind !== "drums" && (
        <Field label="Sound (General MIDI)" id={ids.program}>
          <Select
            value={String(settings.program)}
            onValueChange={(value) => set({ program: Number(value) })}
          >
            <SelectTrigger id={ids.program} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GM_FAMILIES.map((family, f) => (
                <SelectGroup key={family}>
                  <SelectLabel>{family}</SelectLabel>
                  {GM_INSTRUMENTS.slice(f * 8, f * 8 + 8).map((name, i) => (
                    <SelectItem key={name} value={String(f * 8 + i)}>
                      {f * 8 + i + 1}. {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {kind === "stringed" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Strings" id={ids.strings}>
              <Select
                value={String(tuning.length)}
                onValueChange={(value) => set({ tuning: resizeTuning(tuning, Number(value)) })}
              >
                <SelectTrigger id={ids.strings} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STRING_COUNTS.map((count) => (
                    <SelectItem key={count} value={String(count)}>
                      {count} strings
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Capo" id={ids.capo}>
              <Input
                id={ids.capo}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_CAPO}
                value={settings.capo}
                onChange={(event) =>
                  set({ capo: Math.min(MAX_CAPO, Math.max(0, event.target.valueAsNumber || 0)) })
                }
              />
            </Field>
          </div>
          <Field label="Tuning" id={ids.tuning}>
            <Select
              value={presetName ?? CUSTOM}
              onValueChange={(name) => {
                const preset = tuningPresets(tuning.length).find((p) => p.name === name);
                if (preset) set({ tuning: [...preset.tuning] });
              }}
            >
              <SelectTrigger id={ids.tuning} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tuningPresets(tuning.length).map((preset) => (
                  <SelectItem key={preset.name} value={preset.name}>
                    {preset.name} (
                    {preset.tuning.map((p) => pitchName(p, { octave: false })).join(" ")})
                  </SelectItem>
                ))}
                {!presetName && <SelectItem value={CUSTOM}>Custom</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
          <TuningEditor tuning={tuning} onChange={(next) => set({ tuning: next })} />
        </>
      )}

      {kind === "drums" && <DrumKitTable kit={drumKit} />}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{adding ? "Add track" : "Apply"}</Button>
      </DialogFooter>
    </form>
  );
}

const STRING_COUNTS = Array.from(
  { length: MAX_STRINGS - MIN_STRINGS + 1 },
  (_, i) => i + MIN_STRINGS,
);

/**
 * Adds a track (`initial` null) or changes one: name, instrument (any General
 * MIDI program), strings, tuning and capo; drum tracks show their kit's
 * notation map.
 */
export function TrackDialog({
  open,
  onOpenChange,
  initial,
  drumKit,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The track to change, or null to add one. */
  initial: TrackSettings | null;
  drumKit: DrumMapping[];
  onSubmit: (settings: TrackSettings) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <TrackForm
          initial={initial}
          drumKit={drumKit}
          onSubmit={(settings) => {
            onSubmit(settings);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
