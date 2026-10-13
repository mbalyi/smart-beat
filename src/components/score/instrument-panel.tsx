import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

import { BetaBadge } from "@/components/beta-badge";
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
  INSTRUMENT_SIZES,
  instrumentViewName,
  isBlackKey,
  keyboardRange,
  readInstrumentSize,
  storeInstrumentSize,
  type KitEntry,
} from "@/lib/score/instrument-view";
import { LabeledSlider } from "@/components/labeled-slider";
import { pitchName, tuningLabel, type TrackKind } from "@/lib/score/music";
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
  onFretDelete,
  onPlayString,
  onOpenTuner,
  onOpenRecord,
}: {
  tuning: number[];
  capo: number;
  active: NoteInfo[];
  editing: boolean;
  cursorString: number | null;
  scale: Scale | null;
  onFret: (string: number, fretFromNut: number) => void;
  /** Double-click on a note: deletes it (#90). */
  onFretDelete?: (string: number, fretFromNut: number) => void;
  /** Plays an open string's note, to tune by ear (#83). */
  onPlayString?: (pitch: number) => void;
  onOpenTuner?: () => void;
  /** Opens Record to Tab for this track (#108). */
  onOpenRecord?: () => void;
}) {
  const strings = fretboardStrings(tuning);
  const positions = fretPositions(active, capo);
  const isActive = (string: number, fret: number) =>
    positions.some((p) => p.string === string && p.fret === fret);
  const boardRef = useRef<HTMLDivElement>(null);
  const hadNote = useRef(false);
  const [focus, setFocus] = useState({
    string: cursorString ?? strings[0]?.string ?? 1,
    fret: capo,
  });
  const frets = Array.from({ length: FRET_COUNT + 1 }, (_, fret) => fret);
  const name = tuningLabel(tuning);

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
  /** The fret under the mouse or the keyboard focus, shown above the board (one shared tooltip). */
  const [hint, setHint] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          {name}: {strings.map((s) => s.label).join(" ")}
          {capo > 0 && ` · Capo ${capo}`}
        </span>
        {onOpenTuner && (
          <button
            type="button"
            onClick={onOpenTuner}
            className="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Tuner…
          </button>
        )}
        {onOpenRecord && (
          <button
            type="button"
            onClick={onOpenRecord}
            className="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Record…
            <BetaBadge className="ml-1.5 inline-block align-middle no-underline" />
          </button>
        )}
        {editing && (
          // The buttons have the same text as their names: screen readers need no copy.
          <span aria-hidden="true" data-testid="fret-hint" className="font-medium text-foreground">
            {hint ?? "Point at a fret to see its note"}
          </span>
        )}
      </p>
      <div
        ref={boardRef}
        role={editing ? "group" : "img"}
        aria-label={
          editing
            ? `Fretboard: click a fret to enter it${scaleSummary}`
            : `Fretboard. ${summary}${scaleSummary}`
        }
        className="relative grid w-full min-w-max gap-y-0.5"
        style={{
          gridTemplateColumns: `2rem repeat(${FRET_COUNT + 1}, minmax(calc(1.75rem * var(--instrument-size, 1)), 1fr))`,
        }}
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
              className={cn(
                "flex items-center justify-end pr-1 text-xs font-medium text-muted-foreground",
                onPlayString && "cursor-pointer hover:text-foreground",
              )}
              aria-hidden="true"
              data-testid="string-name"
              title={onPlayString ? `Hear ${pitchName(s.open)}` : undefined}
              // A mouse shortcut to the string's open note (#83). It is not a control (the board
              // is a picture, or one tab stop): the keyboard reaches the same notes in the tuner.
              onClick={onPlayString && (() => onPlayString(s.open))}
            >
              {s.label}
            </span>
            {frets.map((fret) => {
              const on = isActive(s.string, fret);
              const behindCapo = fret < capo;
              const degree = scale && !behindCapo ? scaleDegree(scale, s.open + fret) : null;
              const cell = cn(
                "relative flex h-[calc(1.75rem*var(--instrument-size,1))] items-center justify-center border-r border-muted-foreground/30 text-[0.7rem] tabular-nums",
                fret === 0 && "border-r-4 border-r-foreground/60",
                fret === capo && capo > 0 && "border-r-4 border-r-amber-600",
                behindCapo && "bg-muted/60 text-muted-foreground/60",
                "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-muted-foreground/60",
              );
              const dot = on && (
                <span
                  className={cn(
                    "relative z-10 flex size-[calc(1.5rem*var(--instrument-size,1))] items-center justify-center rounded-full font-semibold",
                    ACTIVE,
                  )}
                >
                  {fret - capo}
                </span>
              );
              const marker = !on && degree && (
                <span
                  className={cn(
                    "relative z-10 flex size-[calc(1.1rem*var(--instrument-size,1))] items-center justify-center rounded-full border text-[0.55rem] leading-none",
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
                  onMouseEnter={() => setHint(`String ${s.number}, ${label.toLowerCase()}`)}
                  onFocus={() => setHint(`String ${s.number}, ${label.toLowerCase()}`)}
                  onMouseLeave={() => setHint(null)}
                  onClick={(event) => {
                    // A double-click deletes only a note that was there before its first click.
                    if (event.detail <= 1) hadNote.current = on;
                    setFocus({ string: s.string, fret });
                    onFret(s.string, fret);
                  }}
                  onDoubleClick={() => {
                    if (hadNote.current) onFretDelete?.(s.string, fret);
                    hadNote.current = false;
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
        {/* Fret numbers in the middle of the board, under the notes (#83): a layer with the
            board's columns, so the strings' cells keep their places. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 grid items-center"
          style={{ gridTemplateColumns: "inherit" }}
        >
          {FRET_MARKERS.map((fret) => (
            <span
              key={fret}
              data-testid="fret-marker"
              className={cn(
                "flex justify-center text-xs text-foreground tabular-nums opacity-75",
                fret % 12 === 0 ? "font-bold" : "font-medium",
              )}
              style={{ gridColumn: fret + 2, gridRow: 1 }}
            >
              {fret % 12 === 0 ? (
                // Octaves: the number between two dots, on its own patch of paper.
                <span className="rounded-full bg-background px-1">•{fret}•</span>
              ) : (
                fret
              )}
            </span>
          ))}
        </div>
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
        ? "absolute top-0 z-10 h-[60%] w-[calc(0.95rem*var(--instrument-size,1))] -translate-x-1/2 bg-neutral-900 text-white"
        : "relative h-full w-[calc(1.5rem*var(--instrument-size,1))] border border-neutral-400 bg-white text-neutral-600",
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
      className="relative flex h-[calc(6rem*var(--instrument-size,1))] w-max"
    >
      {whites.map((pitch) => key(pitch, false))}
      {keys.filter(isBlackKey).map((pitch) => {
        const whitesBefore = whites.filter((w) => w < pitch).length;
        return key(pitch, true, {
          left: `calc(${whitesBefore * 1.5}rem * var(--instrument-size, 1))`,
        });
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
  const groups = drumPads(used);
  const all = groups.flatMap((g) => g.pads);
  const summary =
    hits.length === 0
      ? "No notes"
      : all
          .filter((p) => hits.includes(p.id))
          .map((p) => p.name)
          .join(", ");

  return (
    <div
      role={editing ? "group" : "img"}
      aria-label={editing ? "Drum pads: click a pad to enter it" : `Drum pads. ${summary}`}
      className="flex flex-col gap-2"
    >
      {groups.map((group) => (
        <div
          key={group.label}
          role={editing ? "group" : undefined}
          aria-label={editing ? group.label : undefined}
        >
          <div
            aria-hidden="true"
            className="mb-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase"
          >
            {group.label}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(calc(6.5rem*var(--instrument-size,1)),1fr))] gap-1">
            {group.pads.map((pad) => {
              const on = hits.includes(pad.id);
              const className = cn(
                "flex h-[calc(2.75rem*var(--instrument-size,1))] items-center gap-1.5 rounded-md border px-1.5 text-left text-xs leading-tight",
                on ? ACTIVE : "bg-background",
              );
              const content = (
                <>
                  <span
                    aria-hidden="true"
                    className="w-6 shrink-0 text-right font-mono text-[0.7rem] font-semibold tabular-nums opacity-80"
                    data-testid="drum-pad-number"
                  >
                    {pad.id}
                  </span>
                  <span className="line-clamp-2 min-w-0">{pad.name}</span>
                </>
              );
              if (!editing) {
                return (
                  <span key={pad.id} className={className} aria-hidden="true">
                    {content}
                  </span>
                );
              }
              return (
                <Tip key={pad.id} label={`${pad.id} · ${pad.name}`}>
                  <button
                    type="button"
                    aria-label={`${pad.id} ${pad.name}`}
                    aria-pressed={on}
                    onClick={() => onDrum(pad.id)}
                    className={cn(
                      className,
                      "outline-none hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-sky-900",
                    )}
                  >
                    {content}
                  </button>
                </Tip>
              );
            })}
          </div>
        </div>
      ))}
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
  onFretDelete,
  onPitch,
  onDrum,
  drumKit = [],
  cursorDrum = null,
  onReplaceDrum,
  onPreviewDrum,
  onPlayString,
  onOpenTuner,
  onOpenRecord,
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
  /** Double-click on a fretboard note deletes it. */
  onFretDelete?: (string: number, fretFromNut: number) => void;
  onPitch: (pitch: number) => void;
  onDrum: (sound: number) => void;
  /** Drums: every articulation the Virtual Drumkit lists. */
  drumKit?: KitEntry[];
  /** Drums: the drum under the edit cursor. */
  cursorDrum?: number | null;
  onReplaceDrum?: (sound: number) => void;
  onPreviewDrum?: (sound: number) => void;
  /** Plays an open string's note (#83). */
  onPlayString?: (pitch: number) => void;
  onOpenTuner?: () => void;
  /** Stringed tracks: opens Record to Tab for this track (#108). */
  onOpenRecord?: () => void;
}) {
  const name = instrumentViewName(kind);
  const [drumView, setDrumView] = useState<"pads" | "kit">("pads");
  const [size, setSize] = useState(readInstrumentSize);
  const changeSize = (next: number) => {
    setSize(next);
    storeInstrumentSize(next);
  };
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
      className="max-h-[45svh] shrink-0 overflow-auto border-t bg-background px-4 py-2 sm:px-6"
      style={{ "--instrument-size": size } as CSSProperties}
      // Scrollable: keyboard users must be able to reach it even when it has no buttons.
      tabIndex={editing ? undefined : 0}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pb-1.5">
        {kind !== "drums" && onScaleChange && (
          <ScalePicker
            scale={shownScale}
            defaultRoot={defaultScaleRoot}
            onChange={onScaleChange}
            triggerRef={scalePickerRef}
          />
        )}
        {/* One size for the fretboard, the keyboard and the drum pads (#83). */}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden="true">Size</span>
          <LabeledSlider
            label="Instrument size"
            valueText={`${Math.round(size * 100)}%`}
            value={INSTRUMENT_SIZES.indexOf(size as (typeof INSTRUMENT_SIZES)[number])}
            min={0}
            max={INSTRUMENT_SIZES.length - 1}
            step={1}
            onValueChange={(i) => changeSize(INSTRUMENT_SIZES[i] ?? 1)}
            className="w-28"
          />
          <span className="w-9 tabular-nums">{Math.round(size * 100)}%</span>
        </div>
      </div>
      {kind === "stringed" ? (
        <Fretboard
          tuning={tuning}
          capo={capo}
          active={active}
          editing={editing}
          cursorString={cursorString}
          scale={shownScale}
          onFret={onFret}
          onFretDelete={onFretDelete}
          onPlayString={onPlayString}
          onOpenTuner={onOpenTuner}
          onOpenRecord={onOpenRecord}
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
