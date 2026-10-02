import { SlidersVerticalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Knob } from "@/components/ui/knob";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { GRAPHIC_EQ_FREQS } from "@/lib/audio/effects";
import { FLAT_EQ, isFlat } from "@/lib/score/mixer";
import type { TrackEq } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const gainText = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
const freqText = (hz: number) =>
  hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;

/** The channel EQ: low, mid (sweepable) and high, or a 10-band graphic EQ. */
export function EqControls({
  name,
  eq,
  onChange,
}: {
  /** "Rhythm guitar", for the controls' accessible names. */
  name: string;
  eq: TrackEq;
  onChange: (eq: TrackEq) => void;
}) {
  const graphic = eq.graphic?.length === 10;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm">
          <Switch
            checked={graphic}
            onCheckedChange={(on) =>
              onChange(
                on ? { ...eq, graphic: GRAPHIC_EQ_FREQS.map(() => 0) } : { ...eq, graphic: [] },
              )
            }
            aria-label={`10-band EQ, ${name}`}
          />
          10-band
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={isFlat(eq)}
          onClick={() => onChange({ ...FLAT_EQ })}
        >
          Flat
        </Button>
      </div>
      {graphic ? (
        <div
          className="grid grid-cols-5 gap-x-1 gap-y-2"
          role="group"
          aria-label={`Graphic EQ, ${name}`}
        >
          {GRAPHIC_EQ_FREQS.map((freq, i) => (
            <Knob
              key={freq}
              size="sm"
              label={`EQ ${freqText(freq)}, ${name}`}
              valueText={gainText(eq.graphic![i] ?? 0)}
              value={eq.graphic![i] ?? 0}
              min={-15}
              max={15}
              step={0.5}
              onValueChange={(v) =>
                onChange({ ...eq, graphic: eq.graphic!.map((g, n) => (n === i ? v : g)) })
              }
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1">
          <Knob
            label={`EQ low, ${name}`}
            valueText={gainText(eq.lowDb)}
            value={eq.lowDb}
            min={-15}
            max={15}
            step={0.5}
            onValueChange={(lowDb) => onChange({ ...eq, lowDb })}
          />
          <Knob
            label={`EQ mid, ${name}`}
            valueText={gainText(eq.midDb)}
            value={eq.midDb}
            min={-15}
            max={15}
            step={0.5}
            onValueChange={(midDb) => onChange({ ...eq, midDb })}
          />
          <Knob
            label={`EQ mid frequency, ${name}`}
            valueText={freqText(eq.midHz)}
            value={eq.midHz}
            min={200}
            max={5000}
            step={10}
            defaultValue={1000}
            onValueChange={(midHz) => onChange({ ...eq, midHz })}
          />
          <Knob
            label={`EQ high, ${name}`}
            valueText={gainText(eq.highDb)}
            value={eq.highDb}
            min={-15}
            max={15}
            step={0.5}
            onValueChange={(highDb) => onChange({ ...eq, highDb })}
          />
        </div>
      )}
    </div>
  );
}

/** The EQ button of a mixer row, with the EQ in a popover. */
export function EqPopover({
  name,
  eq,
  onChange,
  disabled,
}: {
  name: string;
  eq: TrackEq;
  onChange: (eq: TrackEq) => void;
  disabled?: boolean;
}) {
  const active = !isFlat(eq);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={`EQ for ${name}${active ? " (on)" : ""}`}
          title="Channel EQ"
          className={cn(active && "text-primary")}
        >
          <SlidersVerticalIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" aria-label={`EQ, ${name}`}>
        <h3 className="mb-2 text-sm font-medium">EQ: {name}</h3>
        <EqControls name={name} eq={eq} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
