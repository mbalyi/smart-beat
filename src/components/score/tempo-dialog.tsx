import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MAX_TEMPO, MIN_TEMPO } from "@/lib/score/structure";
import { clampTempo, type TempoRequest } from "@/lib/score/tempo";

type Scope = TempoRequest["scope"];

/** What the dialog starts with. Bars and beats are counted from 1 here. */
export interface TempoInitial {
  bpm: number;
  barCount: number;
  /** The bar at the edit cursor, or the start of the selection. */
  bar: number;
  /** The last bar of the selection (the same as `bar` without one). */
  endBar: number;
  /** Beats in the bar at the cursor. */
  beats: number;
  /** The practice speed in percent (#83): the tempo heard is the song's times this. */
  speed?: number;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-24 text-right tabular-nums"
        />
        {suffix && <span className="w-8 text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function TempoForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: TempoInitial;
  onSubmit: (request: TempoRequest) => void;
  onCancel: () => void;
}) {
  const scopeName = useId();
  const [scope, setScope] = useState<Scope>(initial.endBar > initial.bar ? "range" : "from");
  const [bpm, setBpm] = useState(String(initial.bpm));
  const [bar, setBar] = useState(String(initial.bar));
  const [beat, setBeat] = useState("1");
  const [from, setFrom] = useState(String(initial.bar));
  const [to, setTo] = useState(String(initial.endBar));

  const tempo = Number(bpm);
  const valid = Number.isFinite(tempo) && tempo >= MIN_TEMPO && tempo <= MAX_TEMPO;
  const int = (text: string, fallback: number) => {
    const n = Number.parseInt(text, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const value = clampTempo(tempo);
    if (scope === "song") onSubmit({ scope, bpm: value });
    else if (scope === "from") {
      onSubmit({ scope, bar: int(bar, 1) - 1, beat: int(beat, 1) - 1, bpm: value });
    } else {
      onSubmit({ scope, from: int(from, 1) - 1, to: int(to, 1) - 1, bpm: value });
    }
  };

  const choice = (value: Scope, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name={scopeName}
        value={value}
        checked={scope === value}
        onChange={() => setScope(value)}
        className="size-4 accent-sky-600"
      />
      {label}
    </label>
  );

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>Tempo</DialogTitle>
        <DialogDescription>
          Change the speed of the whole song, from a bar on, or for some bars only. It can be
          undone.
        </DialogDescription>
        {initial.speed !== undefined && initial.speed !== 100 && (
          <p className="text-sm" data-testid="tempo-at-speed">
            Song: {initial.bpm} BPM · Playback: {Math.round(initial.bpm * initial.speed) / 100} BPM
            at {initial.speed}% speed. This changes the song&apos;s tempo; the practice speed stays.
          </p>
        )}
      </DialogHeader>
      <DialogBody>
        <NumberField
          label="Tempo"
          value={bpm}
          onChange={setBpm}
          min={MIN_TEMPO}
          max={MAX_TEMPO}
          step={0.5}
          suffix="BPM"
        />
        {!valid && (
          <p role="alert" className="-mt-2 text-xs text-destructive">
            Enter a tempo from {MIN_TEMPO} to {MAX_TEMPO} BPM.
          </p>
        )}

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-1 text-sm font-medium">Applies to</legend>
          {choice("song", "The whole song (the tempo of bar 1)")}
          {choice("from", "From a bar and beat, until the next tempo change")}
          {scope === "from" && (
            <div className="ml-6 flex flex-col gap-2">
              <NumberField
                label="Bar"
                value={bar}
                onChange={setBar}
                min={1}
                max={initial.barCount}
              />
              <NumberField
                label="Beat"
                value={beat}
                onChange={setBeat}
                min={1}
                max={initial.beats}
              />
            </div>
          )}
          {choice("range", "Only some bars (the tempo returns afterwards)")}
          {scope === "range" && (
            <div className="ml-6 flex flex-col gap-2">
              <NumberField
                label="From bar"
                value={from}
                onChange={setFrom}
                min={1}
                max={initial.barCount}
              />
              <NumberField
                label="To bar"
                value={to}
                onChange={setTo}
                min={1}
                max={initial.barCount}
              />
            </div>
          )}
        </fieldset>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid}>
          Apply
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Changes the tempo of the song, from a bar on, or for a range of bars. */
export function TempoDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: TempoInitial;
  onSubmit: (request: TempoRequest) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" onCloseAutoFocus={onCloseAutoFocus}>
        {open && (
          <TempoForm
            initial={initial}
            onSubmit={(request) => {
              onSubmit(request);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
