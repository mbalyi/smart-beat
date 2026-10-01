import { useId, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  LibraryIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  addEffect,
  EFFECT_CATEGORIES,
  EFFECT_DESCRIPTIONS,
  EFFECT_LABELS,
  formatParam,
  MAX_MASTER_EFFECTS,
  MAX_TRACK_EFFECTS,
  moveEffect,
  PARAMS,
  removeEffect,
  replaceEffect,
  withBandGain,
  withParam,
  type DriveMode,
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
import type { AssetKind, BlockProblem, LibraryItem } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const DRIVE_MODES: { value: DriveMode; label: string }[] = [
  { value: "boost", label: "Clean boost" },
  { value: "overdrive", label: "Overdrive (tube screamer)" },
  { value: "distortion", label: "Distortion" },
  { value: "fuzz", label: "Fuzz" },
];

const formatFreq = (hz: number) => (hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`);

function ParamSliders({
  slot,
  onChange,
}: {
  slot: EffectSlot;
  onChange: (slot: EffectSlot) => void;
}) {
  const specs = PARAMS[slot.type] ?? [];
  return (
    <div className="flex flex-col gap-3">
      {specs.map((spec) => {
        const value = (slot as unknown as Record<string, number>)[spec.key] ?? spec.min;
        return (
          <div
            key={spec.key}
            className="grid grid-cols-[6rem_1fr_4.5rem] items-center gap-2 text-sm"
          >
            <span>{spec.label}</span>
            <LabeledSlider
              label={`${EFFECT_LABELS[slot.type]} ${spec.label.toLowerCase()}`}
              valueText={formatParam(spec, value)}
              value={value}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              onValueChange={(v) => onChange(withParam(slot, spec.key, v))}
            />
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatParam(spec, value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm">
        {kind === "amp" ? "Amp or pedal capture" : "Cabinet"}
      </label>
      <div className="flex gap-2">
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
          Import a Neural Amp Modeler capture (.nam) of an amp or pedal. It stays on this computer.
        </p>
      )}
    </div>
  );
}

function BlockEditor({
  slot,
  library,
  onChange,
  onImport,
}: {
  slot: EffectSlot;
  library: LibraryItem[];
  onChange: (slot: EffectSlot) => void;
  onImport: (kind: AssetKind) => void;
}) {
  const modeId = useId();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{EFFECT_DESCRIPTIONS[slot.type]}</p>
      {slot.type === "drive" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={modeId} className="text-sm">
            Type
          </label>
          <Select
            value={slot.mode}
            onValueChange={(mode) => onChange({ ...slot, mode: mode as DriveMode })}
          >
            <SelectTrigger id={modeId} size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DRIVE_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
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
        <div className="flex flex-col gap-2" role="group" aria-label="Equalizer bands">
          {slot.bands.map((band, i) => {
            const shaping = band.kind === "highPass" || band.kind === "lowPass";
            const label = `${shaping ? (band.kind === "highPass" ? "High pass" : "Low pass") : formatFreq(band.freq)}`;
            return (
              <div key={i} className="grid grid-cols-[6rem_1fr_4.5rem] items-center gap-2 text-sm">
                <span>{label}</span>
                {shaping ? (
                  <span className="text-xs text-muted-foreground">at {formatFreq(band.freq)}</span>
                ) : (
                  <LabeledSlider
                    label={`Equalizer ${label}`}
                    valueText={`${band.gainDb > 0 ? "+" : ""}${band.gainDb.toFixed(1)} dB`}
                    value={band.gainDb}
                    min={-12}
                    max={12}
                    step={0.5}
                    onValueChange={(v) => onChange(withBandGain(slot, i, v))}
                  />
                )}
                <span className="text-right text-xs text-muted-foreground tabular-nums">
                  {shaping ? "" : `${band.gainDb > 0 ? "+" : ""}${band.gainDb.toFixed(1)} dB`}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <ParamSliders slot={slot} onChange={onChange} />
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

/**
 * The pedalboard: a track's (or the master's) chain of effects, in signal
 * order. Add from the library by category, remove (button or Delete), reorder
 * (drag, the arrow buttons or Alt+↑/↓), switch blocks on and off, turn knobs,
 * and load or save presets.
 */
export function PedalboardDialog({
  open,
  onOpenChange,
  target,
  chain,
  onChange,
  problems = [],
  library,
  onImport,
  onManageLibrary,
  engineOn,
  onEnableEngine,
  focusType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PedalboardTarget;
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
  /** Select this kind of block when opening (the EQ button). */
  focusType?: EffectType;
}) {
  const limit = target.track === null ? MAX_MASTER_EFFECTS : MAX_TRACK_EFFECTS;
  // Mounted again for every opening (see the `key` the workspace passes).
  const [selected, setSelected] = useState(() =>
    Math.max(0, focusType ? chain.findIndex((slot) => slot.type === focusType) : 0),
  );
  const [genre, setGenre] = useState<Genre | "all">("all");
  const [presetName, setPresetName] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const listId = useId();
  const presetNameId = useId();

  const current = chain[Math.min(selected, chain.length - 1)];
  const currentIndex = Math.min(selected, chain.length - 1);
  const problemOf = (index: number) => problems.find((p) => p.index === index)?.message;
  const presets = presetsFor(target.presetTarget, genre === "all" ? null : genre);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length) return;
    onChange(moveEffect(chain, from, to));
    setSelected(to);
  };
  const remove = (index: number) => {
    onChange(removeEffect(chain, index));
    setSelected(Math.max(0, Math.min(index, chain.length - 2)));
  };

  const onRowKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(index);
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      move(index, index + (event.key === "ArrowUp" ? -1 : 1));
    }
  };

  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    if (dragFrom !== null) move(dragFrom, index);
    setDragFrom(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Effects: {target.name}</DialogTitle>
          <DialogDescription>
            Up to {limit} effects, played from top to bottom.{" "}
            {target.track === null ? "The master chain processes the whole mix." : ""}
          </DialogDescription>
        </DialogHeader>

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

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground" id={`${listId}-genre`}>
              Genre
            </span>
            <Select value={genre} onValueChange={(v) => setGenre(v as Genre | "all")}>
              <SelectTrigger size="sm" aria-labelledby={`${listId}-genre`} className="w-36">
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
            <span className="text-xs text-muted-foreground" id={`${listId}-preset`}>
              {TARGET_LABELS[target.presetTarget]} presets
            </span>
            <Select
              value=""
              onValueChange={(id) => {
                const preset = presets.find((p) => p.id === id);
                if (preset) {
                  onChange(chainOf(preset).slice(0, limit));
                  setSelected(0);
                }
              }}
            >
              <SelectTrigger size="sm" aria-labelledby={`${listId}-preset`} className="w-full">
                <SelectValue placeholder="Load a preset…" />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    <span className="text-muted-foreground"> · {p.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <form
            className="flex items-end gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (!presetName.trim()) return;
              saveUserPreset(presetName, target.presetTarget, chain);
              setPresetName("");
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={presetNameId} className="text-xs text-muted-foreground">
                Save as preset
              </label>
              <Input
                id={presetNameId}
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
              aria-label="Save the preset"
              disabled={!presetName.trim() || chain.length === 0}
            >
              <SaveIcon />
            </Button>
          </form>
        </div>

        <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
          <div className="flex flex-col gap-2">
            <h3 id={listId} className="text-xs font-semibold tracking-wide uppercase">
              Signal chain
            </h3>
            {chain.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                No effects yet.
              </p>
            ) : (
              <ol aria-labelledby={listId} className="flex flex-col gap-1">
                {chain.map((slot, i) => {
                  const problem = problemOf(i);
                  return (
                    // Dragging is a mouse shortcut; the move buttons and Alt+↑/↓ do the same.
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                    <li
                      key={i}
                      draggable
                      onDragStart={() => setDragFrom(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDrop(e, i)}
                      data-testid="effect-block"
                      className={cn(
                        "flex items-center gap-1 rounded-md border px-1 py-1",
                        i === currentIndex && "border-primary bg-primary/5",
                        !slot.enabled && "opacity-60",
                      )}
                    >
                      <GripVerticalIcon
                        className="size-4 shrink-0 cursor-grab text-muted-foreground"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate rounded px-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-current={i === currentIndex ? "true" : undefined}
                        aria-keyshortcuts="Delete Alt+ArrowUp Alt+ArrowDown"
                        onClick={() => setSelected(i)}
                        onKeyDown={(e) => onRowKeyDown(e, i)}
                      >
                        {i + 1}. {EFFECT_LABELS[slot.type]}
                        {problem && (
                          <TriangleAlertIcon
                            className="ml-1 inline size-3.5 text-amber-600"
                            aria-label={problem}
                          />
                        )}
                      </button>
                      <Switch
                        checked={slot.enabled}
                        onCheckedChange={(enabled) =>
                          onChange(replaceEffect(chain, i, { ...slot, enabled }))
                        }
                        aria-label={`${EFFECT_LABELS[slot.type]} ${i + 1} on`}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${EFFECT_LABELS[slot.type]} up`}
                        disabled={i === 0}
                        onClick={() => move(i, i - 1)}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Move ${EFFECT_LABELS[slot.type]} down`}
                        disabled={i === chain.length - 1}
                        onClick={() => move(i, i + 1)}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${EFFECT_LABELS[slot.type]}`}
                        onClick={() => remove(i)}
                      >
                        <Trash2Icon />
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="flex gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={chain.length >= limit}>
                    <PlusIcon data-icon="inline-start" />
                    Add effect
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {EFFECT_CATEGORIES.map((category, c) => (
                    <div key={category.label}>
                      {c > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel>{category.label}</DropdownMenuLabel>
                      {category.types.map((type) => (
                        <DropdownMenuItem
                          key={type}
                          onSelect={() => {
                            onChange(addEffect(chain, type, limit));
                            setSelected(chain.length);
                          }}
                        >
                          {EFFECT_LABELS[type]}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="sm" onClick={onManageLibrary}>
                <LibraryIcon data-icon="inline-start" />
                Sound library…
              </Button>
            </div>
            {chain.length >= limit && (
              <p className="text-xs text-muted-foreground">The chain is full ({limit} effects).</p>
            )}
          </div>

          <section aria-label="Effect settings" className="min-w-0 rounded-md border p-3">
            {current ? (
              <>
                <h3 className="mb-2 font-medium">
                  {currentIndex + 1}. {EFFECT_LABELS[current.type]}
                </h3>
                {problemOf(currentIndex) && (
                  <p role="alert" className="mb-2 text-sm text-amber-700 dark:text-amber-400">
                    {problemOf(currentIndex)}
                  </p>
                )}
                <BlockEditor
                  slot={current}
                  library={library}
                  onChange={(slot) => onChange(replaceEffect(chain, currentIndex, slot))}
                  onImport={onImport}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Add an effect, or load a preset for your genre.
              </p>
            )}
          </section>
        </div>

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
