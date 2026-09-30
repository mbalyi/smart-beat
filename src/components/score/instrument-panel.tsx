import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

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
} from "@/lib/score/instrument-view";
import { pitchName, tuningName, type TrackKind } from "@/lib/score/music";
import { cn } from "@/lib/utils";

const ACTIVE = "bg-sky-600 text-white dark:bg-sky-500";

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
  onFret,
}: {
  tuning: number[];
  capo: number;
  active: NoteInfo[];
  editing: boolean;
  cursorString: number | null;
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

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        {name ?? "Custom tuning"}: {strings.map((s) => s.label).join(" ")}
        {capo > 0 && ` · Capo ${capo}`}
      </p>
      <div
        ref={boardRef}
        role={editing ? "group" : "img"}
        aria-label={editing ? "Fretboard: click a fret to enter it" : `Fretboard. ${summary}`}
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
              if (!editing) {
                return (
                  <span key={fret} className={cell} aria-hidden="true">
                    {dot}
                  </span>
                );
              }
              const label = `Fret ${fret}, ${pitchName(s.open + fret, { spoken: true })}`;
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
                  {dot}
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
  onPitch,
}: {
  active: NoteInfo[];
  editing: boolean;
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

  const key = (pitch: number, black: boolean, style?: CSSProperties) => {
    const on = pitches.includes(pitch);
    const className = cn(
      "flex items-end justify-center rounded-b-sm pb-1 text-[0.6rem]",
      black
        ? "absolute top-0 z-10 h-[60%] w-[0.95rem] -translate-x-1/2 bg-neutral-900 text-white"
        : "h-full w-6 border border-neutral-400 bg-white text-neutral-600",
      on && ACTIVE,
    );
    const label = pitch % 12 === 0 ? pitchName(pitch) : "";
    if (!editing) {
      return (
        <span key={pitch} className={className} style={style} aria-hidden="true">
          {label}
        </span>
      );
    }
    return (
      <button
        key={pitch}
        type="button"
        data-pitch={pitch}
        tabIndex={pitch === focused ? 0 : -1}
        aria-label={pitchName(pitch, { spoken: true })}
        aria-pressed={on}
        onClick={() => {
          setFocus(pitch);
          onPitch(pitch);
        }}
        onKeyDown={(event) => move(event, pitch)}
        className={cn(className, "outline-none focus-visible:ring-2 focus-visible:ring-ring")}
        style={style}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      ref={ref}
      role={editing ? "group" : "img"}
      aria-label={
        editing ? "Piano keyboard: click a key to enter it" : `Piano keyboard. ${summary}`
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
            </span>
          );
        }
        return (
          <button
            key={pad.id}
            type="button"
            aria-label={pad.name}
            aria-pressed={on}
            title={`${pad.name} (MIDI ${pad.id})`}
            onClick={() => onDrum(pad.id)}
            className={cn(
              className,
              "outline-none hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-sky-900",
            )}
          >
            {pad.short}
          </button>
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
  onFret,
  onPitch,
  onDrum,
}: {
  kind: TrackKind;
  tuning: number[];
  capo: number;
  active: NoteInfo[];
  editing: boolean;
  cursorString: number | null;
  drumSounds?: number[];
  onFret: (string: number, fretFromNut: number) => void;
  onPitch: (pitch: number) => void;
  onDrum: (sound: number) => void;
}) {
  const name = instrumentViewName(kind);
  return (
    <section
      aria-label={name}
      className="max-h-[35svh] shrink-0 overflow-auto border-t bg-background px-4 py-2 sm:px-6"
      // Scrollable: keyboard users must be able to reach it even when it has no buttons.
      tabIndex={editing ? undefined : 0}
    >
      {kind === "stringed" ? (
        <Fretboard
          tuning={tuning}
          capo={capo}
          active={active}
          editing={editing}
          cursorString={cursorString}
          onFret={onFret}
        />
      ) : kind === "drums" ? (
        <DrumPads active={active} editing={editing} used={drumSounds} onDrum={onDrum} />
      ) : (
        <PianoKeyboard active={active} editing={editing} onPitch={onPitch} />
      )}
    </section>
  );
}
