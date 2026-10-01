import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { VirtualDrumkit } from "@/components/score/virtual-drumkit";
import type { NoteInfo } from "@/lib/score/editor";
import {
  drumPads,
  FRET_COUNT,
  FRET_MARKERS,
  fretboardStrings,
  fretPositions,
  instrumentViewName,
  isBlackKey,
  keyboardRange,
  type KitEntry,
} from "@/lib/score/instrument-view";
import { pitchName, tuningName, type TrackKind } from "@/lib/score/music";
import {
  describeScale,
  SCALE_ROOTS,
  SCALE_TYPES,
  scaleDegree,
  scalePrefersFlats,
  type Scale,
} from "@/lib/score/scales";
import { spellPitchClass } from "@/lib/score/keys";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";

const ACTIVE = "bg-sky-600 text-white dark:bg-sky-500";

/** How the scale tool marks the root and the other notes of the scale. */
const SCALE_ROOT = "border-amber-600 bg-amber-500 text-white dark:bg-amber-600";
const SCALE_NOTE = "border-amber-600 bg-background text-amber-900 dark:text-amber-100";

/** ", scale root" / ", in the scale" for the spoken name of a fret or key. */
const degreeText = (degree: "root" | "in" | null) =>
  degree === "root" ? ", scale root" : degree === "in" ? ", in the scale" : "";

/** Picks the scale the fretboard or keyboard shows (or none). */
function ScalePicker({
  scale,
  defaultRoot,
  onChange,
  triggerRef,
}: {
  scale: Scale | null;
  /** The root to start with (the key's tonic). */
  defaultRoot: number;
  onChange: (scale: Scale | null) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const typeId = useId();
  const rootId = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <label htmlFor={typeId} className="font-medium">
        Scale
      </label>
      <Select
        value={scale?.type ?? "off"}
        onValueChange={(type) =>
          onChange(type === "off" ? null : { root: scale?.root ?? defaultRoot, type })
        }
      >
        <SelectTrigger ref={triggerRef} id={typeId} size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Off</SelectItem>
          {SCALE_TYPES.map((type) => (
            <SelectItem key={type.id} value={type.id}>
              {type.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label htmlFor={rootId} className="font-medium">
        Root
      </label>
      <Select
        value={String(scale?.root ?? defaultRoot)}
        disabled={!scale}
        onValueChange={(root) => scale && onChange({ ...scale, root: Number(root) })}
      >
        <SelectTrigger id={rootId} size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCALE_ROOTS.map((root) => (
            <SelectItem key={root.pitchClass} value={String(root.pitchClass)}>
              {root.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {scale && <span className="text-muted-foreground">{describeScale(scale)}</span>}
    </div>
  );
}

/** Moves focus between buttons in a roving-tabindex group. */
function focusButton(container: HTMLElement | null, selector: string) {
  container?.querySelector<HTMLButtonElement>(selector)?.focus();
}

function Fretboard({
  tuning,
  capo,
  active,
  editing,
  cursorString,
  scale,
  onFret,
}: {
  tuning: number[];
  capo: number;
  active: NoteInfo[];
  editing: boolean;
  cursorString: number | null;
  scale: Scale | null;
  onFret: (string: number, fretFromNut: number) => void;
}) {
  const strings = fretboardStrings(tuning);
  const positions = fretPositions(active, capo);
  const isActive = (string: number, fret: number) =>
    positions.some((p) => p.string === string && p.fret === fret);
  const boardRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState({
    string: cursorString ?? strings[0]?.string ?? 1,
    fret: capo,
  });
  const frets = Array.from({ length: FRET_COUNT + 1 }, (_, fret) => fret);
  const name = tuningName(tuning);

  const move = (event: KeyboardEvent, string: number, fret: number) => {
    const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 0], ArrowDown: [-1, 0] }[
      event.key
    ];
    if (!delta) return;
    event.preventDefault();
    const next = {
      string: Math.min(tuning.length, Math.max(1, string + delta[0]!)),
      fret: Math.min(FRET_COUNT, Math.max(capo, fret + delta[1]!)),
    };
    setFocus(next);
    focusButton(boardRef.current, `[data-string="${next.string}"][data-fret="${next.fret}"]`);
  };

  const summary =
    positions.length === 0
      ? "No notes"
      : positions
          .map((p) => {
            const open = tuning[tuning.length - p.string]!;
            return `string ${tuning.length - p.string + 1} fret ${p.fret} (${pitchName(open + p.fret, { spoken: true })})`;
          })
          .join(", ");
  const scaleSummary = scale ? `. Scale: ${describeScale(scale, { spoken: true })}` : "";
  const flats = scale ? scalePrefersFlats(scale) : false;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        {name ?? "Custom tuning"}: {strings.map((s) => s.label).join(" ")}
        {capo > 0 && ` · Capo ${capo}`}
      </p>
      <div
        ref={boardRef}
        role={editing ? "group" : "img"}
        aria-label={
          editing
            ? `Fretboard: click a fret to enter it${scaleSummary}`
            : `Fretboard. ${summary}${scaleSummary}`
        }
        className="grid w-max gap-y-0.5"
        style={{ gridTemplateColumns: `2rem repeat(${FRET_COUNT + 1}, minmax(1.75rem, 1fr))` }}
      >
        {strings.map((s) => (
          <div
            key={s.string}
            role={editing ? "group" : undefined}
            aria-label={
              editing ? `String ${s.number} (${pitchName(s.open, { spoken: true })})` : undefined
            }
            className={cn(
              "contents",
              editing && cursorString === s.string && "[&>*]:bg-sky-100 dark:[&>*]:bg-sky-950",
            )}
          >
            <span
              className="flex items-center justify-end pr-1 text-xs font-medium text-muted-foreground"
              aria-hidden="true"
            >
              {s.label}
            </span>
            {frets.map((fret) => {
              const on = isActive(s.string, fret);
              const behindCapo = fret < capo;
              const degree = scale && !behindCapo ? scaleDegree(scale, s.open + fret) : null;
              const cell = cn(
                "relative flex h-6 items-center justify-center border-r border-muted-foreground/30 text-[0.65rem] tabular-nums",
                fret === 0 && "border-r-4 border-r-foreground/60",
                fret === capo && capo > 0 && "border-r-4 border-r-amber-600",
                behindCapo && "bg-muted/60 text-muted-foreground/60",
                "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-muted-foreground/60",
              );
              const dot = on && (
                <span
                  className={cn(
                    "relative z-10 flex size-5 items-center justify-center rounded-full font-semibold",
                    ACTIVE,
                  )}
                >
                  {fret - capo}
                </span>
              );
              const marker = !on && degree && (
                <span
                  className={cn(
                    "relative z-10 flex size-4 items-center justify-center rounded-full border text-[0.55rem] leading-none",
                    degree === "root" ? SCALE_ROOT : SCALE_NOTE,
                  )}
                >
                  {spellPitchClass(s.open + fret, flats)}
                </span>
              );
              if (!editing) {
                return (
                  <span key={fret} className={cell} aria-hidden="true">
                    {dot || marker}
                  </span>
                );
              }
              const label = `Fret ${fret}, ${pitchName(s.open + fret, { spoken: true })}${degreeText(degree)}`;
              return (
                <button
                  key={fret}
                  type="button"
                  data-string={s.string}
                  data-fret={fret}
                  disabled={behindCapo}
                  tabIndex={focus.string === s.string && focus.fret === fret ? 0 : -1}
                  aria-label={label}
                  aria-pressed={on}
                  title={`String ${s.number}, ${label.toLowerCase()}`}
                  onClick={() => {
                    setFocus({ string: s.string, fret });
                    onFret(s.string, fret);
                  }}
                  onKeyDown={(event) => move(event, s.string, fret)}
                  className={cn(
                    cell,
                    "outline-none hover:bg-sky-100 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-sky-900",
                  )}
                >
                  {dot || marker}
                </button>
              );
            })}
          </div>
        ))}
        <span aria-hidden="true" />
        {frets.map((fret) => (
          <span
            key={fret}
            aria-hidden="true"
            className="flex flex-col items-center text-[0.65rem] leading-tight text-muted-foreground tabular-nums"
          >
            <span className="h-3">
              {FRET_MARKERS.includes(fret) ? (fret % 12 === 0 ? "••" : "•") : ""}
            </span>
            <span className={cn(FRET_MARKERS.includes(fret) && "font-semibold text-foreground")}>
              {fret}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PianoKeyboard({
  active,
  editing,
  scale,
  onPitch,
}: {
  active: NoteInfo[];
  editing: boolean;
  scale: Scale | null;
  onPitch: (pitch: number) => void;
}) {
  const pitches = active.map((n) => n.pitch);
  const { low, high } = keyboardRange(pitches);
  const keys = Array.from({ length: high - low + 1 }, (_, i) => low + i);
  const whites = keys.filter((k) => !isBlackKey(k));
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(60);
  const focused = keys.includes(focus) ? focus : low;
  const summary =
    pitches.length === 0
      ? "No notes"
      : pitches.map((p) => pitchName(p, { spoken: true })).join(", ");

  const move = (event: KeyboardEvent, pitch: number) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: low - pitch, End: high - pitch }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = Math.min(high, Math.max(low, pitch + step));
    setFocus(next);
    focusButton(ref.current, `[data-pitch="${next}"]`);
  };

  const scaleSummary = scale ? `. Scale: ${describeScale(scale, { spoken: true })}` : "";
  const key = (pitch: number, black: boolean, style?: CSSProperties) => {
    const on = pitches.includes(pitch);
    const degree = scale ? scaleDegree(scale, pitch) : null;
    const className = cn(
      "flex items-end justify-center rounded-b-sm pb-1 text-[0.6rem]",
      black
        ? "absolute top-0 z-10 h-[60%] w-[0.95rem] -translate-x-1/2 bg-neutral-900 text-white"
        : "relative h-full w-6 border border-neutral-400 bg-white text-neutral-600",
      on && ACTIVE,
    );
    const label = pitch % 12 === 0 ? pitchName(pitch) : "";
    const marker = degree && !on && (
      <span
        className={cn(
          "absolute bottom-4 size-2.5 rounded-full border",
          degree === "root" ? SCALE_ROOT : SCALE_NOTE,
        )}
      />
    );
    const content = (
      <>
        {marker}
        {label}
      </>
    );
    if (!editing) {
      return (
        <span key={pitch} className={className} style={style} aria-hidden="true">
          {content}
        </span>
      );
    }
    return (
      <button
        key={pitch}
        type="button"
        data-pitch={pitch}
        tabIndex={pitch === focused ? 0 : -1}
        aria-label={`${pitchName(pitch, { spoken: true })}${degreeText(degree)}`}
        aria-pressed={on}
        onClick={() => {
          setFocus(pitch);
          onPitch(pitch);
        }}
        onKeyDown={(event) => move(event, pitch)}
        className={cn(className, "outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        style={style}
      >
        {content}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      role={editing ? "group" : "img"}
      aria-label={
        editing
          ? `Piano keyboard: click a key to enter it${scaleSummary}`
          : `Piano keyboard. ${summary}${scaleSummary}`
      }
      className="relative flex h-24 w-max"
    >
      {whites.map((pitch) => key(pitch, false))}
      {keys.filter(isBlackKey).map((pitch) => {
        const whitesBefore = whites.filter((w) => w < pitch).length;
        return key(pitch, true, { left: `${whitesBefore * 1.5}rem` });
      })}
    </div>
  );
}

function DrumPads({
  active,
  editing,
  used,
  onDrum,
}: {
  active: NoteInfo[];
  editing: boolean;
  /** Drum sounds the track uses, so unusual ones get a pad too. */
  used: number[];
  onDrum: (sound: number) => void;
}) {
  const hits = active.map((n) => n.pitch);
  const pads = drumPads(used);
  const summary =
    hits.length === 0
      ? "No notes"
      : pads
          .filter((p) => hits.includes(p.id))
          .map((p) => p.name)
          .join(", ");

  return (
    <div
      role={editing ? "group" : "img"}
      aria-label={editing ? "Drum pads: click a pad to enter it" : `Drum pads. ${summary}`}
      className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1"
    >
      {pads.map((pad) => {
        const on = hits.includes(pad.id);
        const className = cn(
          "flex h-10 flex-col items-center justify-center rounded-md border px-1 text-xs leading-tight",
          on ? ACTIVE : "bg-background",
        );
        if (!editing) {
          return (
            <span key={pad.id} className={className} aria-hidden="true">
              {pad.short}
              <span className="text-[0.6rem] tabular-nums opacity-70">{pad.id}</span>
            </span>
          );
        }
        return (
          <Tip key={pad.id} label={`${pad.name} · ${pad.id}`}>
            <button
              type="button"
              aria-label={pad.name}
              aria-pressed={on}
              onClick={() => onDrum(pad.id)}
              className={cn(
                className,
                "outline-none hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-sky-900",
              )}
            >
              {pad.short}
              <span aria-hidden="true" className="text-[0.6rem] tabular-nums opacity-70">
                {pad.id}
              </span>
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/**
 * The notes being played (or under the edit cursor) on the track's
 * instrument: a fretboard for stringed tracks, a piano keyboard for other
 * pitched tracks and pads for drums. In edit mode, clicking enters notes.
 */
export function InstrumentPanel({
  kind,
  tuning,
  capo,
  active,
  editing,
  cursorString,
  drumSounds = [],
  scale = null,
  defaultScaleRoot = 0,
  scalePickerRef,
  onScaleChange,
  onFret,
  onPitch,
  onDrum,
  drumKit = [],
  cursorDrum = null,
  onReplaceDrum,
  onPreviewDrum,
}: {
  kind: TrackKind;
  tuning: number[];
  capo: number;
  active: NoteInfo[];
  editing: boolean;
  cursorString: number | null;
  drumSounds?: number[];
  /** The scale the scale tool shows, or null. */
  scale?: Scale | null;
  /** The root the scale tool starts with (the key's tonic). */
  defaultScaleRoot?: number;
  scalePickerRef?: RefObject<HTMLButtonElement | null>;
  onScaleChange?: (scale: Scale | null) => void;
  onFret: (string: number, fretFromNut: number) => void;
  onPitch: (pitch: number) => void;
  onDrum: (sound: number) => void;
  /** Drums: every articulation the Virtual Drumkit lists. */
  drumKit?: KitEntry[];
  /** Drums: the drum under the edit cursor. */
  cursorDrum?: number | null;
  onReplaceDrum?: (sound: number) => void;
  onPreviewDrum?: (sound: number) => void;
}) {
  const name = instrumentViewName(kind);
  const [drumView, setDrumView] = useState<"pads" | "kit">("pads");
  const shownScale = kind === "drums" ? null : scale;
  /** Clicks on the keys, frets and pads must not move the keyboard focus out of the score (typing and arrows continue there). */
  const keepFocus = (event: MouseEvent<HTMLElement>) => {
    if (editing && (event.target as Element).closest("button:not([role=combobox])")) {
      event.preventDefault();
    }
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only keeps focus where it is; the buttons inside are the interactive elements
    <section
      aria-label={name}
      onMouseDown={keepFocus}
      className="max-h-[35svh] shrink-0 overflow-auto border-t bg-background px-4 py-2 sm:px-6"
      // Scrollable: keyboard users must be able to reach it even when it has no buttons.
      tabIndex={editing ? undefined : 0}
    >
      {kind !== "drums" && onScaleChange && (
        <div className="pb-1.5">
          <ScalePicker
            scale={shownScale}
            defaultRoot={defaultScaleRoot}
            onChange={onScaleChange}
            triggerRef={scalePickerRef}
          />
        </div>
      )}
      {kind === "stringed" ? (
        <Fretboard
          tuning={tuning}
          capo={capo}
          active={active}
          editing={editing}
          cursorString={cursorString}
          scale={shownScale}
          onFret={onFret}
        />
      ) : kind === "drums" ? (
        <div className="flex flex-col gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Drum view"
            value={drumView}
            onValueChange={(value) => value && setDrumView(value === "kit" ? "kit" : "pads")}
            className="self-start"
          >
            <ToggleGroupItem value="pads">Pads</ToggleGroupItem>
            <ToggleGroupItem value="kit">Virtual drumkit</ToggleGroupItem>
          </ToggleGroup>
          {drumView === "pads" ? (
            <DrumPads active={active} editing={editing} used={drumSounds} onDrum={onDrum} />
          ) : (
            <VirtualDrumkit
              kit={drumKit}
              active={active.map((n) => n.pitch)}
              cursorSound={cursorDrum}
              editing={editing}
              onInsert={onDrum}
              onReplace={onReplaceDrum ?? onDrum}
              onPreview={onPreviewDrum ?? (() => {})}
            />
          )}
        </div>
      ) : (
        <PianoKeyboard active={active} editing={editing} scale={shownScale} onPitch={onPitch} />
      )}
    </section>
  );
}
