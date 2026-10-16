import { useId } from "react";

import { EffectsPlaybackNotice } from "@/components/audio/effects-playback-notice";
import { GainReductionMeter, LevelMeter } from "@/components/audio/level-meter";
import { LabeledSlider } from "@/components/labeled-slider";
import { PanControl } from "@/components/pan-control";
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
import { Knob } from "@/components/ui/knob";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  defaultDrumMixer,
  DRUM_ELEMENTS,
  elementMix,
  withElementMix,
} from "@/lib/audio/drum-elements";
import { describeDb, describePan, panLabel } from "@/lib/score/mixer";
import {
  applyDynamicsPreset,
  dynamicsPresetsFor,
  matchingDynamicsPreset,
} from "@/lib/audio/dynamics-presets";
import {
  formatParam,
  MAX_TRACK_EFFECTS,
  PARAMS,
  replaceEffect,
  withFocusBlock,
  withParam,
  type EffectSlot,
} from "@/lib/audio/effects";
import type { DrumMixer } from "@/lib/tauri";
import { cn } from "@/lib/utils";

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
  busChain,
  onBusChainChange,
  onBrowsePresets,
}: {
  /** Opens the preset browser on the drum mixes (#42). */
  onBrowsePresets?: () => void;
  /**
   * The drum track's effect chain: its drum bus, after the kit pieces are
   * mixed (#39). Its compressor is edited here too.
   */
  busChain?: EffectSlot[];
  onBusChainChange?: (slots: EffectSlot[]) => void;
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
      <DialogContent size="full" className="sm:max-w-[min(calc(100%-2rem),78rem)]">
        <DialogHeader>
          <DialogTitle>Drum mixer: {trackName}</DialogTitle>
          <DialogDescription>
            Each piece of the kit has its own level, pan, mute and solo.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <EffectsPlaybackNotice
            subject="drum mixer"
            engineOn={engineOn}
            onEnable={onEnableEngine}
          />

          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={current.stereo ? "stereo" : "mono"}
            onValueChange={(v) => v && onChange({ ...current, stereo: v === "stereo" })}
            aria-label="Kit output"
            data-tour="drum-kit-output"
            className="self-start"
          >
            <ToggleGroupItem value="mono">Mono</ToggleGroupItem>
            <ToggleGroupItem value="stereo">Stereo</ToggleGroupItem>
          </ToggleGroup>

          <ol
            className="flex gap-1 overflow-x-auto rounded-md border p-2"
            aria-label="Kit pieces"
            data-tour="drum-kit-pieces"
          >
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
                    "flex min-w-14 flex-1 basis-14 flex-col items-center gap-2 rounded-md bg-muted/30 px-1 py-2 text-sm",
                    silent && "text-muted-foreground",
                  )}
                >
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
                  <span className="flex h-40 items-stretch gap-1.5" title={describeDb(mix.volume)}>
                    <LabeledSlider
                      orientation="vertical"
                      label={`Volume, ${element.label}`}
                      valueText={describeDb(mix.volume)}
                      value={mix.volume}
                      onValueChange={(volume) => set({ volume })}
                    />
                    <LevelMeter
                      orientation="vertical"
                      className="h-full"
                      label={`Level, ${element.label}`}
                      select={(m) => m.drums?.[trackIndex]?.[i] ?? 0}
                    />
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {describeDb(mix.volume)}
                  </span>
                  <PanControl
                    variant="knob"
                    size="sm"
                    label={`Pan, ${element.label}`}
                    valueText={current.stereo ? describePan(mix.pan) : "Centre (mono)"}
                    value={mix.pan}
                    disabled={!current.stereo}
                    onValueChange={(pan) => set({ pan })}
                  />
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {panLabel(current.stereo ? mix.pan : 0)}
                  </span>
                  <span className="h-24 rotate-180 text-center font-medium whitespace-nowrap [text-orientation:mixed] [writing-mode:vertical-rl]">
                    {element.label}
                  </span>
                </li>
              );
            })}
          </ol>

          {busChain && onBusChainChange && (
            <BusCompressor chain={busChain} onChange={onBusChainChange} trackIndex={trackIndex} />
          )}
        </DialogBody>

        <DialogFooter>
          {onBrowsePresets && (
            <Button variant="outline" className="sm:mr-auto" onClick={onBrowsePresets}>
              Drum mix presets…
            </Button>
          )}
          <Button variant="outline" onClick={() => onChange(null)} disabled={!mixer}>
            Reset the kit
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The knobs shown for the bus compressor (the pedalboard has all of them). */
const BUS_KNOBS = ["thresholdDb", "ratio", "attackMs", "releaseMs", "makeupDb", "mix"];

/**
 * The drum bus compressor (#39): the compressor of the drum track's chain,
 * which squeezes the whole mixed kit. Added on demand, with drum presets and
 * a gain-reduction meter.
 */
function BusCompressor({
  chain,
  onChange,
  trackIndex,
}: {
  chain: EffectSlot[];
  onChange: (slots: EffectSlot[]) => void;
  trackIndex: number;
}) {
  const presetId = useId();
  const index = chain.findIndex((slot) => slot.type === "compressor");
  const slot = index >= 0 ? chain[index]! : null;
  const full = chain.length >= MAX_TRACK_EFFECTS;
  const values = slot as unknown as Record<string, number> | null;
  const presets = dynamicsPresetsFor("compressor");
  const current = slot ? matchingDynamicsPreset(slot) : undefined;

  return (
    <section
      aria-labelledby={`${presetId}-title`}
      data-tour="drum-bus"
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${presetId}-title`} className="text-sm font-medium">
          Bus compressor
        </h3>
        {slot && (
          <span className="flex items-center gap-2 text-xs">
            On
            <Switch
              checked={slot.enabled}
              onCheckedChange={(enabled) =>
                onChange(replaceEffect(chain, index, { ...slot, enabled }))
              }
              aria-label="Bus compressor on"
            />
          </span>
        )}
      </div>
      {!slot ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {full
              ? "The drum track's effect chain is full: remove an effect on its pedalboard first."
              : "Compresses the whole kit after the mixer, as on a drum bus."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={full}
            onClick={() => {
              const next = withFocusBlock(chain, "compressor", MAX_TRACK_EFFECTS);
              const added = next.chain[next.index];
              const preset = presets.find((p) => p.id === "comp-parallel-drum-bus");
              if (added && preset) next.chain[next.index] = applyDynamicsPreset(added, preset);
              onChange(next.chain);
            }}
          >
            Add a bus compressor
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={presetId} className="text-xs">
              Preset
            </label>
            <Select
              value={current?.id ?? ""}
              onValueChange={(id) => {
                const preset = presets.find((p) => p.id === id);
                if (preset)
                  onChange(replaceEffect(chain, index, applyDynamicsPreset(slot, preset)));
              }}
            >
              <SelectTrigger id={presetId} size="sm" className="w-56">
                <SelectValue placeholder="Custom" />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {(PARAMS.compressor ?? [])
              .filter((spec) => BUS_KNOBS.includes(spec.key))
              .map((spec) => (
                <Knob
                  key={spec.key}
                  label={`Bus compressor, ${spec.label}`}
                  valueText={formatParam(spec, values![spec.key] ?? spec.min)}
                  value={values![spec.key] ?? spec.min}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  onValueChange={(v) =>
                    onChange(replaceEffect(chain, index, withParam(slot, spec.key, v)))
                  }
                />
              ))}
          </div>
          <GainReductionMeter
            label="Bus compressor: gain reduction"
            select={(m) => m.reduction?.tracks[trackIndex]?.[index] ?? 0}
          />
        </>
      )}
    </section>
  );
}
