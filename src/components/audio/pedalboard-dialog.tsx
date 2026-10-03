import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GripVerticalIcon,
  LibraryIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { GainReductionMeter } from "@/components/audio/level-meter";
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
import { Knob } from "@/components/ui/knob";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  CHOICES,
  EFFECT_CATEGORIES,
  EFFECT_DESCRIPTIONS,
  EFFECT_LABELS,
  formatParam,
  insertEffect,
  MAX_MASTER_EFFECTS,
  MAX_TRACK_EFFECTS,
  moveEffect,
  PARAMS,
  removeEffect,
  replaceEffect,
  TOGGLES,
  withBandGain,
  withOption,
  withParam,
  type EffectSlot,
  type EffectType,
} from "@/lib/audio/effects";
import {
  chainOf,
  GENRE_LABELS,
  GENRES,
  presetsFor,
  saveUserPreset,
  TARGET_LABELS,
  type Genre,
  type PresetTarget,
} from "@/lib/audio/presets";
import { MAX_SOUNDS } from "@/lib/score/mixer";
import {
  applyDynamicsPreset,
  dynamicsPresetsFor,
  matchingDynamicsPreset,
} from "@/lib/audio/dynamics-presets";
import type {
  AssetKind,
  BlockProblem,
  EngineMeters,
  LibraryItem,
  SongPreset,
  SoundSwitch,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const formatFreq = (hz: number) => (hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`);
const formatGain = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;

/** What is being dragged: a new effect from the library, or a pedal of the board. */
type Dragged = { kind: "new"; type: EffectType } | { kind: "move"; from: number };

function LibrarySelect({
  kind,
  value,
  items,
  onChange,
  onImport,
}: {
  kind: AssetKind;
  value: string;
  items: LibraryItem[];
  onChange: (id: string) => void;
  onImport: (kind: AssetKind) => void;
}) {
  const id = useId();
  const options = items.filter((item) => item.kind === kind);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs">
        {kind === "amp" ? "Amp or pedal capture" : "Cabinet"}
      </label>
      <div className="flex gap-1">
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger id={id} size="sm" className="min-w-0 flex-1">
            <SelectValue placeholder={kind === "amp" ? "Choose a capture…" : "Choose a cabinet…"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
                {item.includesCab && (
                  <span className="text-muted-foreground"> · includes a cabinet</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => onImport(kind)}>
          Import…
        </Button>
      </div>
      {kind === "amp" && options.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Import a Neural Amp Modeler capture (.nam). It stays on this computer.
        </p>
      )}
    </div>
  );
}

/** The controls on a pedal: switches, choices and knobs. */
function PedalControls({
  slot,
  name,
  library,
  onChange,
  onImport,
  reduction,
}: {
  /** Reads this pedal's gain reduction from the engine's meters (compressor, limiter). */
  reduction?: (meters: EngineMeters) => number;
  slot: EffectSlot;
  /** "Drive 2", used in the controls' accessible names. */
  name: string;
  library: LibraryItem[];
  onChange: (slot: EffectSlot) => void;
  onImport: (kind: AssetKind) => void;
}) {
  const choiceId = useId();
  const presetId = useId();
  const values = slot as unknown as Record<string, number | string | boolean>;
  const presets = dynamicsPresetsFor(slot.type);
  const preset = matchingDynamicsPreset(slot);
  return (
    <div className="flex flex-col gap-2">
      {presets.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor={presetId} className="text-xs">
            Preset
          </label>
          <Select
            value={preset?.id ?? ""}
            onValueChange={(id) => {
              const chosen = presets.find((p) => p.id === id);
              if (chosen) onChange(applyDynamicsPreset(slot, chosen));
            }}
          >
            <SelectTrigger
              id={presetId}
              size="sm"
              className="w-full"
              aria-label={`${name}: preset`}
            >
              <SelectValue placeholder="Custom" />
            </SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.id} value={p.id} title={p.description}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {reduction && (slot.type === "compressor" || slot.type === "limiter") && (
        <GainReductionMeter select={reduction} label={`${name}: gain reduction`} />
      )}
      {CHOICES[slot.type]?.map((choice) => (
        <div key={choice.key} className="flex flex-col gap-1">
          <label htmlFor={`${choiceId}-${choice.key}`} className="text-xs">
            {choice.label}
          </label>
          <Select
            value={String(values[choice.key])}
            onValueChange={(value) => onChange(withOption(slot, choice.key, value))}
          >
            <SelectTrigger id={`${choiceId}-${choice.key}`} size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choice.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {TOGGLES[slot.type]?.map((toggle) => (
        <span key={toggle.key} className="flex items-center justify-between gap-2 text-xs">
          {toggle.label}
          <Switch
            checked={Boolean(values[toggle.key])}
            onCheckedChange={(on) => onChange(withOption(slot, toggle.key, on))}
            aria-label={`${name}: ${toggle.label}`}
          />
        </span>
      ))}
      {slot.type === "amp" && (
        <LibrarySelect
          kind="amp"
          value={slot.model}
          items={library}
          onChange={(model) => onChange({ ...slot, model })}
          onImport={onImport}
        />
      )}
      {slot.type === "cab" && (
        <LibrarySelect
          kind="cab"
          value={slot.ir}
          items={library}
          onChange={(ir) => onChange({ ...slot, ir })}
          onImport={onImport}
        />
      )}
      {slot.type === "eq" ? (
        <div className="grid grid-cols-5 gap-x-1 gap-y-2" role="group" aria-label={`${name} bands`}>
          {slot.bands.map((band, i) => {
            const shaping = band.kind === "highPass" || band.kind === "lowPass";
            const label = shaping
              ? `${band.kind === "highPass" ? "High pass" : "Low pass"} ${formatFreq(band.freq)}`
              : formatFreq(band.freq);
            return shaping ? (
              <span key={i} className="self-center text-center text-[10px] text-muted-foreground">
                {label}
              </span>
            ) : (
              <Knob
                key={i}
                size="sm"
                label={`${name}, ${label}`}
                valueText={formatGain(band.gainDb)}
                value={band.gainDb}
                min={-12}
                max={12}
                step={0.5}
                onValueChange={(v) => onChange(withBandGain(slot, i, v))}
              />
            );
          })}
        </div>
      ) : (
        PARAMS[slot.type] && (
          <div className="grid grid-cols-3 gap-x-1 gap-y-2">
            {PARAMS[slot.type]!.map((spec) => {
              const value = Number(values[spec.key] ?? spec.min);
              return (
                <Knob
                  key={spec.key}
                  label={`${name}, ${spec.label}`}
                  valueText={formatParam(spec, value)}
                  value={value}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  onValueChange={(v) => onChange(withParam(slot, spec.key, v))}
                />
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

export interface PedalboardTarget {
  /** Track index, or null for the master bus. */
  track: number | null;
  /** "Rhythm guitar", "Master". */
  name: string;
  presetTarget: PresetTarget;
}

/** A track's sounds (several chains, switched along the song). */
export interface PedalboardSounds {
  names: string[];
  /** The sound being edited. */
  current: number;
  switches: SoundSwitch[];
  barCount: number;
  onSelect: (sound: number) => void;
  onAdd: () => void;
  onRename: (sound: number, name: string) => void;
  onRemove: (sound: number) => void;
  onSwitchesChange: (switches: SoundSwitch[]) => void;
}

function SoundsBar({ sounds }: { sounds: PedalboardSounds }) {
  const id = useId();
  const [renaming, setRenaming] = useState<string | null>(null);
  const many = sounds.names.length > 1;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground" id={`${id}-sound`}>
          Sound
        </span>
        {renaming === null ? (
          <Select value={String(sounds.current)} onValueChange={(v) => sounds.onSelect(Number(v))}>
            <SelectTrigger size="sm" aria-labelledby={`${id}-sound`} className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sounds.names.map((name, i) => (
                <SelectItem key={i} value={String(i)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming.trim()) sounds.onRename(sounds.current, renaming.trim());
              setRenaming(null);
            }}
          >
            <Input
              aria-labelledby={`${id}-sound`}
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              className="h-8 w-40"
              maxLength={40}
            />
            <Button type="submit" size="sm" variant="outline">
              Rename
            </Button>
          </form>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={sounds.onAdd}
        disabled={sounds.names.length >= MAX_SOUNDS}
      >
        <PlusIcon data-icon="inline-start" />
        Add sound
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rename the sound"
        onClick={() => setRenaming(sounds.names[sounds.current] ?? "")}
      >
        <PencilIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Remove the sound"
        disabled={!many}
        onClick={() => sounds.onRemove(sounds.current)}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

/** "From bar 9, play Lead": where the track switches sound. */
function SoundAutomation({ sounds }: { sounds: PedalboardSounds }) {
  const id = useId();
  const { switches, names, barCount } = sounds;
  const change = (index: number, next: SoundSwitch) =>
    sounds.onSwitchesChange(switches.map((s, i) => (i === index ? next : s)));
  const free = () => {
    const used = new Set(switches.map((s) => s.bar));
    let bar = Math.min(barCount - 1, (switches[switches.length - 1]?.bar ?? -1) + 1);
    while (used.has(bar) && bar < barCount - 1) bar++;
    return bar;
  };
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 rounded-md border p-2">
      <h3 id={id} className="text-xs font-semibold tracking-wide uppercase">
        Sound automation
      </h3>
      <p className="text-xs text-muted-foreground">
        The track starts with {names[0]} and switches sound at these bars.
      </p>
      <ol className="flex flex-col gap-1">
        {switches.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex items-center gap-1">
              <label htmlFor={`${id}-bar-${i}`}>From bar</label>
              <Input
                id={`${id}-bar-${i}`}
                type="number"
                min={1}
                max={barCount}
                value={s.bar + 1}
                onChange={(e) => {
                  const bar = Math.round(Number(e.target.value)) - 1;
                  if (Number.isFinite(bar) && bar >= 0 && bar < barCount) change(i, { ...s, bar });
                }}
                className="h-8 w-20"
              />
            </span>
            <span>play</span>
            <Select
              value={String(s.sound)}
              onValueChange={(v) => change(i, { ...s, sound: Number(v) })}
            >
              <SelectTrigger size="sm" className="w-36" aria-label={`Sound from bar ${s.bar + 1}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {names.map((name, n) => (
                  <SelectItem key={n} value={String(n)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove the switch at bar ${s.bar + 1}`}
              onClick={() => sounds.onSwitchesChange(switches.filter((_, n) => n !== i))}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={barCount === 0}
        onClick={() =>
          sounds.onSwitchesChange([
            ...switches,
            { bar: free(), sound: Math.min(names.length - 1, 1) },
          ])
        }
      >
        <PlusIcon data-icon="inline-start" />
        Add a switch
      </Button>
    </section>
  );
}

/**
 * The pedalboard: a track's (or the master's) chain of effects, played from
 * left to right. Drag effects from the library onto the board (or use their
 * Add buttons), drag pedals to reorder them (or Alt+←/→), drag them back to
 * the library or press Delete to remove them, turn the knobs, switch pedals
 * on and off, and load or save presets. Tracks can have several sounds that
 * switch along the song.
 */
export function PedalboardDialog({
  open,
  onOpenChange,
  target,
  trackName,
  onTargetChange,
  chain,
  onChange,
  problems = [],
  library,
  onImport,
  onManageLibrary,
  engineOn,
  onEnableEngine,
  focusType,
  sounds,
  songPresets = [],
  onSongPresetsChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PedalboardTarget;
  /** The current track, for the Track / Mastering switch (missing: no switch). */
  trackName?: string;
  onTargetChange?: (mastering: boolean) => void;
  chain: EffectSlot[];
  onChange: (chain: EffectSlot[]) => void;
  problems?: BlockProblem[];
  library: LibraryItem[];
  onImport: (kind: AssetKind) => void;
  onManageLibrary: () => void;
  /** Whether the native engine (which plays effects) is on. */
  engineOn: boolean;
  /** Missing when the engine cannot be used here (browser). */
  onEnableEngine?: () => void;
  /** Select this kind of block when opening. */
  focusType?: EffectType;
  sounds?: PedalboardSounds;
  /** Presets saved in the song. */
  songPresets?: SongPreset[];
  onSongPresetsChange?: (presets: SongPreset[]) => void;
}) {
  const limit = target.track === null ? MAX_MASTER_EFFECTS : MAX_TRACK_EFFECTS;
  const full = chain.length >= limit;
  const [selected, setSelected] = useState(() =>
    Math.max(0, focusType ? chain.findIndex((slot) => slot.type === focusType) : 0),
  );
  const [category, setCategory] = useState("all");
  const [genre, setGenre] = useState<Genre | "all">("all");
  const [presetName, setPresetName] = useState("");
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragged = useRef<Dragged | null>(null);
  const boardRef = useRef<HTMLOListElement>(null);
  const ids = useId();

  const problemOf = (index: number) => problems.find((p) => p.index === index)?.message;
  const presets = presetsFor(target.presetTarget, genre === "all" ? null : genre);
  const ownPresets = songPresets.filter((p) => p.target === target.presetTarget);
  const libraryTypes =
    category === "all"
      ? EFFECT_CATEGORIES.flatMap((c) => c.types)
      : (EFFECT_CATEGORIES.find((c) => c.label === category)?.types ?? []);

  // Keyboard moves and removals keep the focus on the board: on the moved
  // pedal, or the one that took the removed pedal's place.
  const focusAfter = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAfter.current;
    focusAfter.current = null;
    if (index !== null) {
      boardRef.current?.querySelectorAll<HTMLElement>("[data-pedal]")[index]?.focus();
    }
  }, [chain]);
  const focusPedal = (index: number) => {
    focusAfter.current = index;
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length || from === to) return;
    onChange(moveEffect(chain, from, to));
    setSelected(to);
    focusPedal(to);
  };
  const remove = (index: number) => {
    onChange(removeEffect(chain, index));
    setSelected(Math.max(0, Math.min(index, chain.length - 2)));
  };
  const add = (type: EffectType, at = chain.length) => {
    if (full) return;
    onChange(insertEffect(chain, type, at, limit));
    setSelected(Math.min(at, chain.length));
  };

  const startDrag = (event: DragEvent, item: Dragged) => {
    dragged.current = item;
    setDragging(item);
    event.dataTransfer?.setData("text/plain", item.kind === "new" ? item.type : `#${item.from}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };
  const endDrag = () => {
    dragged.current = null;
    setDragging(null);
    setDropAt(null);
  };
  /** Drops at board position `index` (before the pedal there; `chain.length`: at the end). */
  const dropOnBoard = (event: DragEvent, index: number) => {
    event.preventDefault();
    const item = dragged.current;
    if (item?.kind === "new") add(item.type, index);
    else if (item?.kind === "move") move(item.from, item.from < index ? index - 1 : index);
    endDrag();
  };
  const dropOnLibrary = (event: DragEvent) => {
    event.preventDefault();
    const item = dragged.current;
    if (item?.kind === "move") remove(item.from);
    endDrag();
  };

  const onPedalKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(index);
      focusPedal(Math.max(0, Math.min(index, chain.length - 2)));
    } else if (event.altKey && ["ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      move(index, index - 1);
    } else if (event.altKey && ["ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      move(index, index + 1);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="full">
        <DialogHeader>
          <DialogTitle>Pedalboard: {target.name}</DialogTitle>
          <DialogDescription>
            Up to {limit} effects, played from left to right.{" "}
            {target.track === null
              ? "The mastering chain processes the whole mix."
              : "Drag effects from the library onto the board, or use their Add buttons."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {onTargetChange && trackName && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={target.track === null ? "master" : "track"}
              onValueChange={(v) => v && onTargetChange(v === "master")}
              aria-label="Chain to edit"
              className="self-start"
            >
              <ToggleGroupItem value="track">Current track: {trackName}</ToggleGroupItem>
              <ToggleGroupItem value="master">Mastering</ToggleGroupItem>
            </ToggleGroup>
          )}

          {!engineOn && (
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-amber-600"
                aria-hidden="true"
              />
              <span className="flex-1">
                Effects are heard with the native audio engine.{" "}
                {onEnableEngine
                  ? "They are saved either way."
                  : "It is available in the Smart Beat desktop app."}
              </span>
              {onEnableEngine && (
                <Button size="xs" variant="outline" onClick={onEnableEngine}>
                  Turn it on
                </Button>
              )}
            </p>
          )}

          {sounds && target.track !== null && <SoundsBar sounds={sounds} />}

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground" id={`${ids}-genre`}>
                Genre
              </span>
              <Select value={genre} onValueChange={(v) => setGenre(v as Genre | "all")}>
                <SelectTrigger size="sm" aria-labelledby={`${ids}-genre`} className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All genres</SelectItem>
                  {GENRES.map((g) => (
                    <SelectItem key={g} value={g}>
                      {GENRE_LABELS[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <span className="text-xs text-muted-foreground" id={`${ids}-preset`}>
                {TARGET_LABELS[target.presetTarget]} presets
              </span>
              <Select
                value=""
                onValueChange={(id) => {
                  const own = id.startsWith("song:") ? ownPresets[Number(id.slice(5))] : undefined;
                  const preset = presets.find((p) => p.id === id);
                  const next = own ? structuredClone(own.effects) : preset ? chainOf(preset) : null;
                  if (next) {
                    onChange(next.slice(0, limit));
                    setSelected(0);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-labelledby={`${ids}-preset`} className="w-full">
                  <SelectValue placeholder="Load a preset…" />
                </SelectTrigger>
                <SelectContent>
                  {ownPresets.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>In this song</SelectLabel>
                      {ownPresets.map((p, i) => (
                        <SelectItem key={`song:${i}`} value={`song:${i}`}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  <SelectGroup>
                    <SelectLabel>Library</SelectLabel>
                    {presets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        <span className="text-muted-foreground"> · {p.description}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <form
              className="flex items-end gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const name = presetName.trim();
                if (!name) return;
                const inSong =
                  (event.nativeEvent as SubmitEvent).submitter?.dataset.where === "song";
                if (inSong && onSongPresetsChange) {
                  const others = songPresets.filter(
                    (p) => !(p.name === name && p.target === target.presetTarget),
                  );
                  onSongPresetsChange([
                    ...others,
                    { name, target: target.presetTarget, effects: structuredClone(chain) },
                  ]);
                } else {
                  saveUserPreset(name, target.presetTarget, chain);
                }
                setPresetName("");
              }}
            >
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-name`} className="text-xs text-muted-foreground">
                  Save as preset
                </label>
                <Input
                  id={`${ids}-name`}
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Name"
                  className="h-8 w-36"
                  maxLength={60}
                />
              </div>
              <Button
                type="submit"
                size="icon-sm"
                variant="outline"
                aria-label="Save the preset to my presets"
                title="Save to my presets"
                data-where="library"
                disabled={!presetName.trim() || chain.length === 0}
              >
                <SaveIcon />
              </Button>
              {onSongPresetsChange && (
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  data-where="song"
                  disabled={!presetName.trim() || chain.length === 0}
                >
                  Save in this song
                </Button>
              )}
            </form>
          </div>

          <div className="grid min-w-0 gap-3 md:grid-cols-[14rem_1fr]">
            {/* Dropping a pedal here removes it (a mouse shortcut for its Remove button). */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
            <section
              aria-labelledby={`${ids}-library`}
              onDragOver={(e) => dragging?.kind === "move" && e.preventDefault()}
              onDrop={dropOnLibrary}
              data-testid="effect-library"
              className={cn(
                "flex flex-col gap-2 rounded-md border p-2",
                dragging?.kind === "move" && "border-dashed border-destructive bg-destructive/5",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 id={`${ids}-library`} className="text-xs font-semibold tracking-wide uppercase">
                  Library
                </h3>
                <Button variant="ghost" size="xs" onClick={onManageLibrary}>
                  <LibraryIcon data-icon="inline-start" />
                  Sounds…
                </Button>
              </div>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger size="sm" aria-label="Effect category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {EFFECT_CATEGORIES.map((c) => (
                    <SelectItem key={c.label} value={c.label}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {dragging?.kind === "move" && (
                <p className="text-center text-xs text-destructive">Drop here to remove</p>
              )}
              <ul className="flex flex-col gap-1" aria-label="Effects">
                {libraryTypes.map((type) => (
                  // Dragging is a mouse shortcut; the Add button does the same.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                  <li
                    key={type}
                    draggable={!full}
                    onDragStart={(e) => startDrag(e, { kind: "new", type })}
                    onDragEnd={endDrag}
                    data-testid="library-effect"
                    className={cn(
                      "flex items-center gap-1 rounded-md border bg-card px-2 py-1",
                      !full && "cursor-grab",
                    )}
                    title={EFFECT_DESCRIPTIONS[type]}
                  >
                    <GripVerticalIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{EFFECT_LABELS[type]}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={full}
                      aria-label={`Add ${EFFECT_LABELS[type]}`}
                      onClick={() => add(type)}
                    >
                      <PlusIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby={`${ids}-board`} className="flex min-w-0 flex-col gap-2">
              <h3 id={`${ids}-board`} className="text-xs font-semibold tracking-wide uppercase">
                Signal chain{" "}
                <span className="font-normal text-muted-foreground normal-case">
                  ({chain.length} of {limit})
                </span>
              </h3>
              {/* Dropping on the board is a mouse shortcut for the Add buttons. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
              <ol
                ref={boardRef}
                aria-labelledby={`${ids}-board`}
                data-testid="pedalboard"
                className="flex min-h-40 flex-wrap items-start gap-2 rounded-md border border-dashed p-2"
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dropAt === null) setDropAt(chain.length);
                }}
                onDrop={(e) => dropOnBoard(e, dropAt ?? chain.length)}
              >
                {chain.length === 0 && (
                  <li className="m-auto text-sm text-muted-foreground">
                    No effects yet. Drag one here, add one from the library, or load a preset.
                  </li>
                )}
                {chain.map((slot, i) => {
                  const problem = problemOf(i);
                  const name = `${EFFECT_LABELS[slot.type]} ${i + 1}`;
                  return (
                    // A pedal is focusable so Delete and Alt+←/→ work on it (dragging is
                    // the mouse shortcut); its controls are inside.
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                    <li
                      key={i}
                      data-pedal
                      data-testid="effect-block"
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                      tabIndex={0}
                      aria-label={`${name}${slot.enabled ? "" : " (off)"}`}
                      aria-current={i === selected ? "true" : undefined}
                      aria-keyshortcuts="Delete Alt+ArrowLeft Alt+ArrowRight"
                      draggable
                      onDragStart={(e) => startDrag(e, { kind: "move", from: i })}
                      onDragEnd={endDrag}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDropAt(i);
                      }}
                      onDrop={(e) => {
                        e.stopPropagation();
                        dropOnBoard(e, i);
                      }}
                      onFocus={() => setSelected(i)}
                      onClick={() => setSelected(i)}
                      onKeyDown={(e) => onPedalKeyDown(e, i)}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border-2 bg-card p-2 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                        slot.type === "eq" ? "w-[19rem]" : "w-[13.5rem]",
                        i === selected ? "border-primary" : "border-border",
                        !slot.enabled && "opacity-60",
                        dragging && dropAt === i && "border-l-4 border-l-primary",
                      )}
                    >
                      <div className="flex items-center gap-1">
                        <GripVerticalIcon
                          className="size-4 shrink-0 cursor-grab text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {i + 1}. {EFFECT_LABELS[slot.type]}
                        </span>
                        <Switch
                          checked={slot.enabled}
                          onCheckedChange={(enabled) =>
                            onChange(replaceEffect(chain, i, { ...slot, enabled }))
                          }
                          aria-label={`${name} on`}
                        />
                      </div>
                      {problem && (
                        <p
                          role="alert"
                          className="flex gap-1 text-xs text-amber-700 dark:text-amber-400"
                        >
                          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                          {problem}
                        </p>
                      )}
                      <PedalControls
                        slot={slot}
                        name={name}
                        reduction={(m) =>
                          (target.track === null
                            ? m.reduction?.master[i]
                            : m.reduction?.tracks[target.track]?.[i]) ?? 0
                        }
                        library={library}
                        onChange={(next) => onChange(replaceEffect(chain, i, next))}
                        onImport={onImport}
                      />
                      <div className="flex items-center justify-between">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Move ${name} left`}
                          disabled={i === 0}
                          onClick={() => move(i, i - 1)}
                        >
                          <ArrowLeftIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${name}`}
                          onClick={() => remove(i)}
                        >
                          <Trash2Icon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Move ${name} right`}
                          disabled={i === chain.length - 1}
                          onClick={() => move(i, i + 1)}
                        >
                          <ArrowRightIcon />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {full && (
                <p className="text-xs text-muted-foreground">
                  The chain is full ({limit} effects).
                </p>
              )}
            </section>
          </div>

          {sounds && target.track !== null && sounds.names.length > 1 && (
            <SoundAutomation sounds={sounds} />
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onChange([])} disabled={chain.length === 0}>
            Clear
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
