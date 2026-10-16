import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
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
  LibraryBigIcon,
} from "lucide-react";

import { EffectsPlaybackNotice } from "@/components/audio/effects-playback-notice";
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
  insertAsset,
  insertEffect,
  insertPlugin,
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
  type PluginFormat,
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
  ScannedPlugin,
  SongPreset,
  SoundSwitch,
} from "@/lib/tauri";
import { usePlugins } from "@/hooks/use-plugins";
import { cn } from "@/lib/utils";

const formatFreq = (hz: number) => (hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`);
const formatGain = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;

/**
 * What is being dragged: a new effect from the library, an amp or cabinet
 * from the user's sound library, an installed plugin, or a pedal of the board.
 *
 * Dragging is built on pointer events, not HTML5 drag events: on macOS the
 * window handles file drops natively, so the webview never delivers
 * `dragstart`/`drop` to elements (#128).
 */
type Dragged =
  | { kind: "new"; type: EffectType }
  | { kind: "asset"; asset: { kind: AssetKind; id: string }; name: string }
  | { kind: "plugin"; plugin: { format: PluginFormat; path: string; name: string } }
  | { kind: "move"; from: number };

/** Where a pointer drag would land: a chain position, or the library (remove). */
type DropZone = { kind: "board"; index: number } | { kind: "library" };

/** How far the pointer must move before a press turns into a drag. */
const DRAG_THRESHOLD = 4;

/** Starting a drag on one of these is that control's job, not the drag's. */
const CONTROL =
  "button, input, select, textarea, [role='slider'], [role='switch'], [contenteditable='true']";

/** "Reverb", "amp My 5150", "Noise gate 2": what the drag preview shows. */
const draggedLabel = (item: Dragged, chain: EffectSlot[]): string => {
  if (item.kind === "new") return EFFECT_LABELS[item.type];
  if (item.kind === "asset") return item.name;
  if (item.kind === "plugin") return item.plugin.name;
  return `${EFFECT_LABELS[chain[item.from]?.type ?? "gate"]} ${item.from + 1}`;
};

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
 * The controls on a plugin pedal: the plugin's own editor window, saving its
 * settings into the block, and its live status (latency, health). The plugin
 * has no knobs here — its window is its interface, like in other DAWs.
 */
function PluginPedalControls({
  slot,
  index,
  plugins,
  onChange,
}: {
  slot: Extract<EffectSlot, { type: "plugin" }>;
  index: number;
  plugins: ReturnType<typeof usePlugins>;
  onChange: (slot: EffectSlot) => void;
}) {
  const [busy, setBusy] = useState<"editor" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = plugins.info.get(index);
  const openEditor = async () => {
    setBusy("editor");
    setError(await plugins.openEditor(index));
    setBusy(null);
  };
  const saveSettings = async () => {
    setBusy("save");
    const result = await plugins.saveState(index);
    if ("state" in result) {
      setError(null);
      onChange({ ...slot, state: result.state });
    } else {
      setError(result.error);
    }
    setBusy(null);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{slot.name || "Plugin"}</span>
        <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] text-foreground uppercase">
          {slot.format}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{plugins.describe(slot, index)}</p>
      {status?.error && (
        <p role="alert" className="flex gap-1 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {status.error}
          {!status.alive && " Playing without it."}
        </p>
      )}
      {error && (
        <p role="alert" className="flex gap-1 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          disabled={busy !== null || !plugins.enabled || !slot.enabled || status?.loading}
          onClick={openEditor}
        >
          {busy === "editor" ? "Opening…" : "Open editor…"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          disabled={busy !== null || !plugins.enabled || !slot.enabled || status?.loading}
          onClick={saveSettings}
          title="Save the plugin's current settings into this block"
        >
          {busy === "save" ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
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
  onBrowsePresets,
}: {
  /** Opens the preset browser (#42). */
  onBrowsePresets?: () => void;
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
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null);
  // A press on something draggable: no text may be selected along the way.
  const [armed, setArmed] = useState(false);
  // The active drag and the pointer that ends it live in refs: the window
  // listeners read them without re-subscribing on every move.
  const dragged = useRef<Dragged | null>(null);
  const pending = useRef<{ item: Dragged; x: number; y: number } | null>(null);
  const zone = useRef<DropZone | null>(null);
  const boardRef = useRef<HTMLOListElement>(null);
  const ids = useId();

  const problemOf = (index: number) => problems.find((p) => p.index === index)?.message;
  const presets = presetsFor(target.presetTarget, genre === "all" ? null : genre);
  const ownPresets = songPresets.filter((p) => p.target === target.presetTarget);
  // The user's own amps and cabinets, and the generated cabinets, to drag onto the board.
  const mySounds = library.filter((item) => item.kind === "amp" || item.kind === "cab");
  // Third-party plugins (opt-in, desktop only). Their blocks come from the
  // scan above, never from the library's effect categories.
  const plugins = usePlugins(target, sounds?.current ?? 0, chain);
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
  const addAsset = (asset: { kind: AssetKind; id: string }, at = chain.length) => {
    if (full) return;
    onChange(insertAsset(chain, asset, at, limit));
    setSelected(Math.min(at, chain.length));
  };
  const addPlugin = (
    plugin: { format: PluginFormat; path: string; name: string },
    at = chain.length,
  ) => {
    if (full) return;
    onChange(insertPlugin(chain, plugin, at, limit));
    setSelected(Math.min(at, chain.length));
  };

  /**
   * Where the pointer currently is: the element under it names its zone
   * (`data-drop-zone`: the library, a pedal, or the board). A pedal takes the
   * drop just before it; the board appends after the last pedal, and between
   * pedals picks the nearest gap.
   */
  const dropZoneAt = (target: EventTarget | null, x: number, y: number): DropZone | null => {
    const element =
      target instanceof Element ? target.closest<HTMLElement>("[data-drop-zone]") : null;
    if (!element) return null;
    if (element.dataset.dropZone === "library")
      return dragged.current?.kind === "move" ? { kind: "library" } : null;
    if (element.dataset.dropZone === "pedal")
      return { kind: "board", index: Number(element.dataset.dropIndex ?? 0) };
    const pedals = Array.from(element.querySelectorAll<HTMLElement>("[data-pedal]"));
    const last = pedals.at(-1);
    if (!last || x > last.getBoundingClientRect().right)
      return { kind: "board", index: pedals.length };
    let index = 0;
    let best = Infinity;
    for (const [i, pedal] of pedals.entries()) {
      const rect = pedal.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const away = (x - cx) ** 2 + (y - cy) ** 2;
      if (away < best) {
        best = away;
        index = i + (x > cx ? 1 : 0);
      }
    }
    return { kind: "board", index };
  };

  const resetDrag = () => {
    pending.current = null;
    dragged.current = null;
    zone.current = null;
    setDragging(null);
    setDropZone(null);
    setDragAt(null);
    setArmed(false);
  };

  const cancelDrag = () => resetDrag();

  /** Ends the drag: applies it where the pointer left off, then resets. */
  const endDrag = () => {
    const item = dragged.current;
    const at = zone.current;
    if (item && at) {
      if (at.kind === "library") {
        if (item.kind === "move") remove(item.from);
      } else if (item.kind === "new") add(item.type, at.index);
      else if (item.kind === "asset") addAsset(item.asset, at.index);
      else if (item.kind === "plugin") addPlugin(item.plugin, at.index);
      // Dropping a pedal back where it was (or just before itself) is a no-op.
      else move(item.from, item.from < at.index ? at.index - 1 : at.index);
    }
    resetDrag();
  };

  // Ending a drag is a window concern: the pointer may be released anywhere.
  const dropEvent = useEffectEvent(endDrag);
  const cancelEvent = useEffectEvent(cancelDrag);
  useEffect(() => {
    const onUp = () => {
      if (dragged.current) {
        // A drag can leave a stray selection behind; the label is not a document.
        if (!window.getSelection()?.isCollapsed) window.getSelection()?.removeAllRanges();
        dropEvent();
      } else {
        pending.current = null;
        setArmed(false);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dragged.current) cancelEvent();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancelEvent);
    window.addEventListener("blur", cancelEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancelEvent);
      window.removeEventListener("blur", cancelEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /** A press on a pedal or a library row starts a drag once it moves far enough. */
  const onDragPointerDown = (event: PointerEvent<HTMLElement>, item: Dragged) => {
    if (event.button !== 0) return;
    if (item.kind !== "move" && full) return;
    const target = event.target;
    if (target instanceof Element && target.closest(CONTROL)) return;
    pending.current = { item, x: event.clientX, y: event.clientY };
    setArmed(true);
  };

  const onDragPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = pending.current;
    if (!dragged.current && start) {
      if (event.buttons !== 1) {
        pending.current = null;
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return;
      pending.current = null;
      dragged.current = start.item;
      setDragging(start.item);
    }
    if (!dragged.current) return;
    setDragAt({ x: event.clientX, y: event.clientY });
    const next = dropZoneAt(event.target, event.clientX, event.clientY);
    zone.current = next;
    setDropZone(next);
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
      <DialogContent size="full" className={cn((dragging || armed) && "select-none")}>
        <DialogHeader>
          <DialogTitle>Pedalboard: {target.name}</DialogTitle>
          <DialogDescription>
            Up to {limit} effects, played from left to right.{" "}
            {target.track === null
              ? "The mastering chain processes the whole mix. Drag effects from the library onto the board, or use their Add buttons."
              : "Drag effects from the library onto the board, or use their Add buttons. Drag a pedal to reorder it, or drag it back to the library to remove it."}
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

          <EffectsPlaybackNotice engineOn={engineOn} onEnable={onEnableEngine} />

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
            {onBrowsePresets && (
              <Button variant="outline" size="sm" onClick={onBrowsePresets}>
                <LibraryBigIcon data-icon="inline-start" />
                Browse presets…
              </Button>
            )}
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

          <div
            className="grid min-w-0 gap-3 md:grid-cols-[14rem_1fr]"
            onPointerMove={onDragPointerMove}
            // Leaving the board and the library cancels the drag: the pointer is
            // no longer over anything that can take the drop.
            onPointerLeave={() => {
              if (!dragged.current) return;
              zone.current = null;
              setDropZone(null);
            }}
          >
            {/* Dropping a pedal here removes it (a mouse shortcut for its Remove button). */}
            <section
              aria-labelledby={`${ids}-library`}
              data-drop-zone="library"
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
              <h4 className="text-xs font-semibold tracking-wide uppercase">My sounds</h4>
              {mySounds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Import amp captures (.nam) and cabinets (.wav) with Sounds…, then drag them here.
                </p>
              ) : (
                <ul className="flex flex-col gap-1" aria-label="Your amps and cabinets">
                  {mySounds.map((item) => {
                    const asset = { kind: item.kind, id: item.id };
                    const label = `${item.kind === "amp" ? "amp" : "cabinet"} ${item.name}`;
                    return (
                      // Dragging is a mouse shortcut; the Add button does the same.
                      <li
                        key={item.id}
                        onPointerDown={(e) =>
                          onDragPointerDown(e, { kind: "asset", asset, name: item.name })
                        }
                        data-testid="library-asset"
                        className={cn(
                          "flex items-center gap-1 rounded-md border bg-card px-2 py-1",
                          !full && "cursor-grab",
                          dragging?.kind === "asset" &&
                            dragging.asset.id === item.id &&
                            "opacity-40",
                        )}
                        title={item.tags.length > 0 ? item.tags.join(", ") : undefined}
                      >
                        <GripVerticalIcon
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {item.kind === "amp" ? "Amp" : "Cab"}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={full}
                          aria-label={`Add ${label}`}
                          onClick={() => addAsset(asset)}
                        >
                          <PlusIcon />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <h4 className="mt-1 text-xs font-semibold tracking-wide uppercase">Plugins</h4>
              {!plugins.available ? (
                <p className="text-xs text-muted-foreground">
                  Third-party plugins need the desktop app.
                </p>
              ) : (
                <>
                  <span className="flex items-center justify-between gap-2 text-xs">
                    Third-party plugins
                    <Switch
                      checked={plugins.enabled}
                      onCheckedChange={plugins.setEnabled}
                      disabled={plugins.applying}
                      aria-label="Use third-party plugins"
                    />
                  </span>
                  {plugins.applying && (
                    <p className="text-xs text-muted-foreground">Loading plugins…</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Your own VST3 and CLAP plugins (amp sims, pedals, cabinets). Each runs isolated
                    outside the app, so a crashing plugin cannot take your song down.
                  </p>
                  {plugins.enabled && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={plugins.scanning}
                        onClick={plugins.refresh}
                      >
                        {plugins.scanning
                          ? "Scanning…"
                          : plugins.scanned.length === 0
                            ? "Scan for plugins…"
                            : "Scan again"}
                      </Button>
                      {plugins.scanned.length === 0 && !plugins.scanning ? (
                        <p className="text-xs text-muted-foreground">
                          No plugins scanned yet. Install a VST3 or CLAP plugin, then scan.
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-1" aria-label="Installed plugins">
                          {plugins.scanned.map((item: ScannedPlugin) => {
                            const plugin = {
                              format: item.format,
                              path: item.path,
                              name: item.name,
                            };
                            const label = `plugin ${item.name}`;
                            return (
                              // Dragging is a mouse shortcut; the Add button does the same.
                              <li
                                key={`${item.format}:${item.path}`}
                                onPointerDown={(e) =>
                                  onDragPointerDown(e, { kind: "plugin", plugin })
                                }
                                data-testid="library-plugin"
                                className={cn(
                                  "flex items-center gap-1 rounded-md border bg-card px-2 py-1",
                                  !full && "cursor-grab",
                                  dragging?.kind === "plugin" &&
                                    dragging.plugin.path === item.path &&
                                    "opacity-40",
                                )}
                                title={`${item.vendor} ${item.version}`.trim()}
                              >
                                <GripVerticalIcon
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                                <span className="text-[10px] text-muted-foreground uppercase">
                                  {item.format}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  disabled={full}
                                  aria-label={`Add ${label}`}
                                  onClick={() => addPlugin(plugin)}
                                >
                                  <PlusIcon />
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {plugins.skipped.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {plugins.skipped.length} file{plugins.skipped.length === 1 ? "" : "s"}{" "}
                          could not load and {plugins.skipped.length === 1 ? "was" : "were"}{" "}
                          skipped.
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
              <h4 className="mt-1 text-xs font-semibold tracking-wide uppercase">Effects</h4>
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
                  <li
                    key={type}
                    onPointerDown={(e) => onDragPointerDown(e, { kind: "new", type })}
                    data-testid="library-effect"
                    className={cn(
                      "flex items-center gap-1 rounded-md border bg-card px-2 py-1",
                      !full && "cursor-grab",
                      dragging?.kind === "new" && dragging.type === type && "opacity-40",
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
                {!engineOn && (
                  <span className="ml-2 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[0.7rem] font-medium tracking-normal text-amber-800 normal-case dark:text-amber-300">
                    Not audible yet
                  </span>
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                Keyboard: focus a pedal, Alt+←/→ moves it and Delete removes it. Add effects with
                the library's Add buttons.
              </p>
              {/* Dropping on the board is a mouse shortcut for the Add buttons. */}
              <ol
                ref={boardRef}
                aria-labelledby={`${ids}-board`}
                data-drop-zone="board"
                data-testid="pedalboard"
                className={cn(
                  "flex min-h-40 flex-wrap items-start gap-2 rounded-md border border-dashed p-2",
                  // The pedals can be edited, but nothing is heard until the engine is on.
                  !engineOn && "border-amber-500/60",
                  dropZone?.kind === "board" && "border-primary",
                )}
              >
                {chain.length === 0 && (
                  <li className="m-auto text-sm text-muted-foreground">
                    No effects yet. Drag one here, add one from the library, or load a preset.
                  </li>
                )}
                {chain.map((slot, i) => {
                  const problem = problemOf(i);
                  const pedalName =
                    slot.type === "plugin" && slot.name ? slot.name : EFFECT_LABELS[slot.type];
                  const name = `${pedalName} ${i + 1}`;
                  return (
                    // A pedal is focusable so Delete and Alt+←/→ work on it; the
                    // header and grip drag it (its controls keep their own pointers).
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                    <li
                      key={i}
                      data-pedal
                      data-drop-zone="pedal"
                      data-drop-index={i}
                      data-testid="effect-block"
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                      tabIndex={0}
                      aria-label={`${name}${slot.enabled ? "" : " (off)"}`}
                      aria-current={i === selected ? "true" : undefined}
                      aria-keyshortcuts="Delete Alt+ArrowLeft Alt+ArrowRight"
                      onPointerDown={(e) => onDragPointerDown(e, { kind: "move", from: i })}
                      onFocus={() => setSelected(i)}
                      onClick={() => setSelected(i)}
                      onKeyDown={(e) => onPedalKeyDown(e, i)}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border-2 bg-card p-2 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                        slot.type === "eq" ? "w-[19rem]" : "w-[13.5rem]",
                        i === selected ? "border-primary" : "border-border",
                        !slot.enabled && "opacity-60",
                        dragging?.kind === "move" && dragging.from === i && "opacity-40",
                        dropZone?.kind === "board" &&
                          dropZone.index === i &&
                          "border-l-4 border-l-primary",
                      )}
                    >
                      <div className="flex items-center gap-1">
                        <GripVerticalIcon
                          data-testid="pedal-grip"
                          className="size-4 shrink-0 cursor-grab text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {i + 1}. {pedalName}
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
                      {slot.type === "plugin" ? (
                        <PluginPedalControls
                          slot={slot}
                          index={i}
                          plugins={plugins}
                          onChange={(next) => onChange(replaceEffect(chain, i, next))}
                        />
                      ) : (
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
                      )}
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
                {dragging &&
                  chain.length > 0 &&
                  dropZone?.kind === "board" &&
                  dropZone.index === chain.length && (
                    <li
                      aria-hidden="true"
                      data-testid="drop-indicator"
                      className="w-1 self-stretch rounded bg-primary"
                    />
                  )}
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
        {dragging && dragAt && (
          <div
            aria-hidden="true"
            data-testid="drag-preview"
            className="pointer-events-none fixed z-50 rounded-md border bg-card px-2 py-1 text-xs shadow-md"
            style={{ left: dragAt.x + 14, top: dragAt.y + 14 }}
          >
            {draggedLabel(dragging, chain)}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
