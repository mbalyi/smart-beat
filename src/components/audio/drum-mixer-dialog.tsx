import { TriangleAlertIcon } from "lucide-react";

import { LevelMeter } from "@/components/audio/level-meter";
import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Knob } from "@/components/ui/knob";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  defaultDrumMixer,
  DRUM_ELEMENTS,
  elementMix,
  withElementMix,
} from "@/lib/audio/drum-elements";
import { describeDb, describePan, shortPan } from "@/lib/score/mixer";
import type { DrumMixer } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const MUTE_PRESSED =
  "data-[state=on]:border-red-700 data-[state=on]:bg-red-700 data-[state=on]:text-white data-[state=on]:hover:bg-red-800 data-[state=on]:hover:text-white";
const SOLO_PRESSED =
  "data-[state=on]:border-amber-400 data-[state=on]:bg-amber-400 data-[state=on]:text-black data-[state=on]:hover:bg-amber-300 data-[state=on]:hover:text-black";

/**
 * The drum mixer (Guitar Pro 8 style): a row per kit piece with mute, solo,
 * volume (shown in dB), pan and a meter that lights up on hits, plus a
 * Mono / Stereo switch for the whole kit. Played by the native engine, which
 * gives every piece its own channel.
 */
export function DrumMixerDialog({
  open,
  onOpenChange,
  trackIndex,
  trackName,
  mixer,
  onChange,
  engineOn,
  onEnableEngine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackIndex: number;
  trackName: string;
  /** Null: the kit plays as one channel (no drum mixer yet). */
  mixer: DrumMixer | null;
  onChange: (mixer: DrumMixer | null) => void;
  engineOn: boolean;
  onEnableEngine?: () => void;
}) {
  const current = mixer ?? defaultDrumMixer();
  const anySolo = current.elements.some((e) => e.solo);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Drum mixer: {trackName}</DialogTitle>
          <DialogDescription>
            Each piece of the kit has its own level, pan, mute and solo.
          </DialogDescription>
        </DialogHeader>

        {!engineOn && (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <TriangleAlertIcon
              className="mt-0.5 size-4 shrink-0 text-amber-600"
              aria-hidden="true"
            />
            <span className="flex-1">
              The drum mixer is heard with the native audio engine.{" "}
              {onEnableEngine
                ? "It is saved either way."
                : "It is available in the Smart Beat desktop app."}
            </span>
            {onEnableEngine && (
              <Button size="xs" variant="outline" onClick={onEnableEngine}>
                Turn it on
              </Button>
            )}
          </p>
        )}

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={current.stereo ? "stereo" : "mono"}
          onValueChange={(v) => v && onChange({ ...current, stereo: v === "stereo" })}
          aria-label="Kit output"
          className="self-start"
        >
          <ToggleGroupItem value="mono">Mono</ToggleGroupItem>
          <ToggleGroupItem value="stereo">Stereo</ToggleGroupItem>
        </ToggleGroup>

        <ol className="flex flex-col divide-y rounded-md border" aria-label="Kit pieces">
          {DRUM_ELEMENTS.map((element, i) => {
            const mix = elementMix(current, element.id);
            const set = (change: Partial<typeof mix>) =>
              onChange(withElementMix(current, { ...mix, ...change }));
            const silent = mix.mute || (anySolo && !mix.solo);
            return (
              <li
                key={element.id}
                data-testid="drum-element"
                className={cn(
                  "grid grid-cols-[7.5rem_3.5rem_minmax(6rem,1fr)_3.75rem_2.5rem_4rem] items-center gap-2 px-2 py-1 text-sm",
                  silent && "text-muted-foreground",
                )}
              >
                <span className="truncate">{element.label}</span>
                <span className="flex gap-0.5">
                  <Toggle
                    size="sm"
                    variant="outline"
                    pressed={mix.mute}
                    onPressedChange={(mute) => set({ mute })}
                    aria-label={`Mute ${element.label}`}
                    className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
                  >
                    M
                  </Toggle>
                  <Toggle
                    size="sm"
                    variant="outline"
                    pressed={mix.solo}
                    onPressedChange={(solo) => set({ solo })}
                    aria-label={`Solo ${element.label}`}
                    className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
                  >
                    S
                  </Toggle>
                </span>
                <span title={describeDb(mix.volume)}>
                  <LabeledSlider
                    label={`Volume, ${element.label}`}
                    valueText={describeDb(mix.volume)}
                    value={mix.volume}
                    onValueChange={(volume) => set({ volume })}
                  />
                </span>
                <span className="text-right text-xs text-muted-foreground tabular-nums">
                  {describeDb(mix.volume)}
                </span>
                <Knob
                  size="sm"
                  showLabel={false}
                  label={`Pan, ${element.label}`}
                  valueText={current.stereo ? describePan(mix.pan) : "Centre (mono)"}
                  value={mix.pan}
                  min={-1}
                  max={1}
                  step={0.05}
                  disabled={!current.stereo}
                  onValueChange={(pan) => set({ pan })}
                />
                <span className="flex items-center gap-1">
                  <span className="w-7 text-xs text-muted-foreground tabular-nums">
                    {shortPan(current.stereo ? mix.pan : 0)}
                  </span>
                  <LevelMeter
                    orientation="vertical"
                    className="h-5"
                    label={`Level, ${element.label}`}
                    select={(m) => m.drums?.[trackIndex]?.[i] ?? 0}
                  />
                </span>
              </li>
            );
          })}
        </ol>

        <DialogFooter>
          <Button variant="outline" onClick={() => onChange(null)} disabled={!mixer}>
            Reset the kit
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
