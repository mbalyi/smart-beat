import {
  EraserIcon,
  ListIcon,
  MagnetIcon,
  MousePointer2Icon,
  OctagonXIcon,
  PencilIcon,
  PianoIcon,
  PlusIcon,
  DrumIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MinusIcon,
  KeyboardMusicIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { ControllerLane } from "@/components/midi/controller-lane";
import { EventList } from "@/components/midi/event-list";
import { InstrumentPicker } from "@/components/midi/instrument-picker";
import { exportLaneMidi, importMidiOntoLane } from "@/components/midi/midi-files";
import {
  GridPicker,
  HumanizeDialog,
  NotePropertiesDialog,
  QuantizeDialog,
  TransposeDialog,
  type NoteChanges,
} from "@/components/midi/note-dialogs";
import { PianoRoll, type NoteShape, type Tool } from "@/components/midi/piano-roll";
import { Button } from "@/components/ui/button";
import { setMidiTake } from "@/lib/audio-lanes/edits";
import { activeMidiTake, sortNotes, transposeNotes, DRUM_CHANNEL } from "@/lib/audio-lanes/midi";
import {
  DEFAULT_GRID,
  DEFAULT_QUANTIZE,
  freezeQuantize,
  gridAround,
  gridStepMs,
  humanizeNotes,
  legatoNotes,
  quantizeNotes,
  snapPitchToScale,
  snapToGrid,
  unquantizeNotes,
  type MidiGrid,
  type QuantizeOptions,
} from "@/lib/audio-lanes/midi-edit";
import { newId } from "@/lib/audio-lanes/model";
import { barAtTimelineMs, timelineMsAtBar, type SongGrid } from "@/lib/audio-lanes/sync";
import {
  PIANO_ROWS,
  drumRows,
  isBlackKey,
  joinNotes,
  rowName,
  splitNotesAt,
  xOf,
  type View,
} from "@/lib/midi-editor/geometry";
import { controllerLabel, isDrumLane, type ControllerKind } from "@/lib/midi-editor/controllers";
import { gridLines } from "@/lib/midi-editor/grid-lines";
import { usePlayheadBar, type PlayheadStore } from "@/lib/score/playhead";
import { laneColor } from "@/lib/score/track-colors";
import { midiPanic, playLaneMidi, type AudioLane, type MidiCc, type MidiNote } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** What the editor shows. */
export type EditorView = "piano" | "drums" | "list";

const KEYS_WIDTH = 132;
const MIN_PX_PER_MS = 0.01;
const MAX_PX_PER_MS = 2;
const AUDITION_MS = 250;

/** The pad names of a pad bank, by key (the drum grid's row names). */
function padNames(lane: AudioLane): Record<number, string> {
  if (lane.instrument?.type !== "pads") return {};
  return Object.fromEntries(lane.instrument.pads.filter((p) => p.name).map((p) => [p.key, p.name]));
}

/**
 * The MIDI editor (ADR 0006), docked under the score like the lane editor: a toolbar (view, tools,
 * note shape, snap, quantize, step input, panic), a ruler, the piano keys or drum names beside
 * the note grid, controller lanes under it, and a bar with the grid, note length and channel.
 * Every change is one Undo step of the lanes.
 */
export function MidiEditor({
  lanes,
  lane,
  index,
  grid: song,
  playhead,
  onClose,
  onEffects,
  onEditPads,
  onWriteTab,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  index: number;
  grid: SongGrid;
  playhead?: PlayheadStore;
  onClose: () => void;
  onEffects: (laneIndex: number) => void;
  /** Opens the pad board for this lane. */
  onEditPads?: () => void;
  /** Writes a clip's notes into the tab. */
  onWriteTab?: (clipId: string) => void;
}) {
  const { audio } = lanes;
  const clips = lane.clips.filter((c) => c.midi);
  const drums = isDrumLane(lane);
  const [clipId, setClipId] = useState<string | null>(null);
  const clip =
    clips.find((c) => c.id === clipId) ??
    clips.find((c) => lanes.selection.includes(c.id)) ??
    clips[0] ??
    null;
  const take = clip ? activeMidiTake(clip) : { notes: [], cc: [] };
  const [view, setView] = useState<EditorView>(drums ? "drums" : "piano");
  const [tool, setTool] = useState<Tool>("draw");
  const [shape, setShape] = useState<NoteShape>(drums ? "triangle" : "bar");
  const [snapOn, setSnapOn] = useState(true);
  const [grid, setGrid] = useState<MidiGrid>(DEFAULT_GRID);
  const [lengthMode, setLengthMode] = useState<"grid" | "last">("grid");
  const [lastLenMs, setLastLenMs] = useState<number | null>(null);
  const [channel, setChannel] = useState(drums ? DRUM_CHANNEL : 0);
  const [pxPerMs, setPxPerMs] = useState(0.15);
  const [hideUnused, setHideUnused] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [controllers, setControllers] = useState<ControllerKind[]>([{ type: "velocity" }]);
  const [dialog, setDialog] = useState<"quantize" | "humanize" | "transpose" | "properties" | null>(
    null,
  );
  const [preview, setPreview] = useState<{ options: QuantizeOptions; grid: MidiGrid } | null>(null);
  const [stepInput, setStepInput] = useState(false);
  const [stepMs, setStepMs] = useState(0);
  const [stepBase, setStepBase] = useState(drums ? 35 : 60);
  const [pointer, setPointer] = useState<{ ms: number; pitch: number | null } | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const color = laneColor(index, lane.color);
  const names = padNames(lane);

  const clipStartMs = clip?.startMs ?? 0;
  const clipMs = clip?.lengthMs ?? 0;
  const used = new Set(take.notes.map((n) => n.pitch));
  const rows = view === "drums" ? drumRows(used, hideUnused, names) : PIANO_ROWS;
  const rowHeight = view === "drums" ? 20 : 14;
  const originMs = Math.max(0, clipStartMs - 1_000);
  const endMs = clipStartMs + clipMs + 4_000;
  const editorView: View = { originMs, pxPerMs, rowHeight, rows };
  const width = Math.max(400, (endMs - originMs) * pxPerMs);
  const lines = gridLines(audio, song, grid, originMs, endMs);
  const snap = (ms: number) => (snapOn ? snapToGrid(audio, song, grid, ms) : ms);
  const stepLen = (at: number) => gridStepMs(audio, song, grid, at);
  const defaultLenMs =
    lengthMode === "last" && lastLenMs ? lastLenMs : stepLen(clipStartMs + stepMs);

  // The quantize dialog's result, shown while it is open.
  const quantized =
    preview && clip
      ? quantizeNotes(
          take.notes,
          clipStartMs,
          (ms) => gridAround(audio, song, preview.grid, ms),
          preview.options,
          selected.size ? selected : null,
        )
      : null;

  // Opens on the notes: the first used row (or middle C) in view.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !clip || scrolledFor.current === `${clip.id}:${view}`) return;
    scrolledFor.current = `${clip.id}:${view}`;
    const top = take.notes.length ? Math.max(...take.notes.map((n) => n.pitch)) : 72;
    const row = Math.max(0, rows.indexOf(top) - 2);
    el.scrollTop = view === "drums" ? 0 : row * rowHeight;
    el.scrollLeft = Math.max(0, xOf(editorView, clipStartMs) - 40);
  });

  const commit = (notes: MidiNote[], cc: MidiCc[] = take.cc) => {
    if (!clip) return;
    lanes.apply((a) => setMidiTake(a, clip.id, { notes: sortNotes(notes), cc }));
  };
  const commitCc = (cc: MidiCc[]) => commit(take.notes, cc);
  const ids = () => (selected.size ? selected : null);

  const audition = (pitch: number, velocity: number) => {
    const chan = view === "drums" ? DRUM_CHANNEL : channel;
    void playLaneMidi(lane.id, [[0x90 | chan, pitch, velocity]]).catch(() => undefined);
    setTimeout(
      () => void playLaneMidi(lane.id, [[0x80 | chan, pitch, 0]]).catch(() => undefined),
      AUDITION_MS,
    );
  };

  const onRollChange = (notes: MidiNote[]) => {
    const added = notes.find((n) => !take.notes.some((m) => m.id === n.id));
    if (added) setLastLenMs(added.lenMs);
    commit(
      notes.map((n) =>
        take.notes.some((m) => m.id === n.id)
          ? n
          : { ...n, chan: view === "drums" ? DRUM_CHANNEL : channel },
      ),
    );
  };

  const select = (next: string[], add: boolean) =>
    setSelected((s) => {
      if (!add) return new Set(next);
      const out = new Set(s);
      for (const id of next) {
        if (out.has(id)) out.delete(id);
        else out.add(id);
      }
      return out;
    });

  const cursorClipMs = Math.min(
    Math.max(0, lanes.editCursorMs - clipStartMs),
    Math.max(0, clipMs - 1),
  );

  const insertStep = (pitch: number) => {
    if (!clip) return;
    const at = stepInput ? stepMs : cursorClipMs;
    const len = Math.min(stepLen(clipStartMs + at), clipMs - at);
    if (len <= 0) return;
    const note: MidiNote = {
      id: newId(),
      startMs: at,
      lenMs: len,
      pitch,
      vel: 100,
      chan: view === "drums" ? DRUM_CHANNEL : channel,
    };
    audition(pitch, note.vel);
    commit([...take.notes, note]);
    setStepMs(Math.min(clipMs, at + len));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("input, select, textarea")) return;
    const mod = event.metaKey || event.ctrlKey;
    const chosen = ids();
    const fKey = /^F(\d{1,2})$/.exec(event.key);
    if (stepInput && fKey && Number(fKey[1]) <= 12) {
      event.preventDefault();
      insertStep(Math.min(127, stepBase + Number(fKey[1]) - 1));
      return;
    }
    switch (event.key) {
      case "Delete":
      case "Backspace":
        if (selected.size === 0) return;
        event.preventDefault();
        commit(take.notes.filter((n) => !selected.has(n.id)));
        setSelected(new Set());
        return;
      case "Escape":
        setSelected(new Set());
        return;
      case "a":
      case "A":
        if (!mod) return;
        event.preventDefault();
        setSelected(new Set(take.notes.map((n) => n.id)));
        return;
      case "ArrowUp":
      case "ArrowDown": {
        if (selected.size === 0) return;
        event.preventDefault();
        const up = event.key === "ArrowUp" ? 1 : -1;
        if (view === "drums" && !mod) {
          const moved = take.notes.map((n) => {
            if (!selected.has(n.id)) return n;
            const row = rows.indexOf(n.pitch) - up;
            return rows[row] === undefined ? n : { ...n, pitch: rows[row]! };
          });
          commit(moved);
        } else commit(transposeNotes(take.notes, selected, up * (event.shiftKey ? 12 : 1)));
        return;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        if (selected.size === 0) return;
        event.preventDefault();
        const dir = event.key === "ArrowRight" ? 1 : -1;
        commit(
          take.notes.map((n) => {
            if (!selected.has(n.id)) return n;
            const step = snapOn ? stepLen(clipStartMs + n.startMs) : 10;
            return { ...n, startMs: Math.min(Math.max(0, n.startMs + dir * step), clipMs - 1) };
          }),
        );
        return;
      }
      case "q":
      case "Q":
        event.preventDefault();
        quantize(DEFAULT_QUANTIZE, grid);
        return;
      case "s":
      case "S":
        if (mod) return;
        event.preventDefault();
        commit(splitNotesAt(take.notes, cursorClipMs, chosen, newId));
        return;
      case "j":
      case "J":
        if (selected.size < 2) return;
        commit(joinNotes(take.notes, selected));
        return;
      case "l":
      case "L":
        commit(legatoNotes(take.notes, chosen));
        return;
      case "m":
      case "M":
        if (selected.size === 0) return;
        commit(take.notes.map((n) => (selected.has(n.id) ? { ...n, muted: !n.muted } : n)));
        return;
      case "i":
      case "I":
        event.preventDefault();
        insertStep(pointer?.pitch ?? stepBase);
        return;
      case "+":
      case "=":
        setPxPerMs((z) => Math.min(MAX_PX_PER_MS, z * 1.25));
        return;
      case "-":
        setPxPerMs((z) => Math.max(MIN_PX_PER_MS, z / 1.25));
        return;
    }
  };

  const quantize = (options: QuantizeOptions, g: MidiGrid) =>
    commit(
      quantizeNotes(
        take.notes,
        clipStartMs,
        (ms) => gridAround(audio, song, g, ms),
        options,
        ids(),
      ),
    );

  const applyProperties = (changes: NoteChanges) =>
    commit(
      take.notes.map((n) => {
        if (!selected.has(n.id)) return n;
        const pitch = changes.pitch?.(n.pitch);
        return {
          ...n,
          ...(pitch !== undefined && pitch !== null && { pitch }),
          ...(changes.vel !== undefined && { vel: changes.vel }),
          ...(changes.chan !== undefined && { chan: changes.chan }),
          ...(changes.lenMs !== undefined && {
            lenMs: Math.min(changes.lenMs, clipMs - n.startMs),
          }),
          ...(changes.startMs !== undefined && { startMs: Math.min(changes.startMs, clipMs - 1) }),
        };
      }),
    );

  const formatMs = (ms: number) => {
    const at = barAtTimelineMs(audio, song, clipStartMs + ms);
    const bar = Math.floor(at);
    const beats = song.beats[bar] ?? 4;
    const beat = (at - bar) * beats;
    return `${bar + 1}.${Math.floor(beat) + 1}.${String(Math.round((beat % 1) * 100)).padStart(2, "0")}`;
  };

  if (!clip) {
    return (
      <section
        aria-label={`MIDI editor: ${lane.name}`}
        data-testid="midi-editor"
        className="flex shrink-0 flex-col items-center gap-2 border-t bg-card p-6 text-sm"
      >
        <p>This MIDI lane has no clip yet.</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => lanes.commands.addMidiClip(lane.id)}>
            <PlusIcon /> New MIDI clip
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </section>
    );
  }

  const shownNotes = quantized ?? take.notes;
  const selectedNotes = take.notes.filter((n) => selected.has(n.id));
  const toggle = (on: boolean) =>
    cn("h-8 gap-1.5 px-2", on && "bg-primary text-primary-foreground hover:bg-primary/90");

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the editor keys bubble up from the focused grid and controls
    <section
      aria-label={`MIDI editor: ${lane.name}`}
      data-testid="midi-editor"
      data-tour="midi-editor"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-[22rem] shrink-0 flex-col border-t bg-card outline-none"
    >
      <div
        role="toolbar"
        aria-label="MIDI editor tools"
        className="flex flex-wrap items-center gap-1 border-b px-2 py-1"
      >
        <span className="mr-1 max-w-48 truncate text-sm font-semibold" title={lane.name}>
          {lane.name}
        </span>
        <InstrumentPicker
          instrument={lane.instrument}
          onChange={(instrument) => lanes.commands.setInstrument(lane.id, instrument)}
          onEditPads={onEditPads}
        />
        {clips.length > 1 && (
          <select
            aria-label="Clip"
            className="h-8 rounded-md border bg-card px-2 text-sm"
            value={clip.id}
            onChange={(e) => {
              setClipId(e.target.value);
              setSelected(new Set());
            }}
          >
            {clips.map((c, i) => (
              <option key={c.id} value={c.id}>
                {`${i + 1}. ${c.takes[c.take]?.name ?? "MIDI clip"} (bar ${Math.floor(barAtTimelineMs(audio, song, c.startMs)) + 1})`}
              </option>
            ))}
          </select>
        )}
        <div
          role="radiogroup"
          aria-label="View"
          className="ml-1 flex gap-0.5 rounded-md border p-0.5"
        >
          <Button
            variant="ghost"
            size="sm"
            role="radio"
            aria-checked={view === "piano"}
            className={toggle(view === "piano")}
            onClick={() => setView("piano")}
          >
            <PianoIcon /> Piano roll
          </Button>
          <Button
            variant="ghost"
            size="sm"
            role="radio"
            aria-checked={view === "drums"}
            className={toggle(view === "drums")}
            onClick={() => setView("drums")}
          >
            <DrumIcon /> Drum grid
          </Button>
          <Button
            variant="ghost"
            size="sm"
            role="radio"
            aria-checked={view === "list"}
            className={toggle(view === "list")}
            onClick={() => setView("list")}
          >
            <ListIcon /> Event list
          </Button>
        </div>
        {view !== "list" && (
          <div role="radiogroup" aria-label="Tool" className="flex gap-0.5 rounded-md border p-0.5">
            <Button
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={tool === "draw"}
              className={toggle(tool === "draw")}
              onClick={() => setTool("draw")}
              title="Draw notes (click and drag)"
            >
              <PencilIcon /> Draw
            </Button>
            <Button
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={tool === "select"}
              className={toggle(tool === "select")}
              onClick={() => setTool("select")}
              title="Select notes (drag a box)"
            >
              <MousePointer2Icon /> Select
            </Button>
            <Button
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={tool === "erase"}
              className={toggle(tool === "erase")}
              onClick={() => setTool("erase")}
              title="Erase notes (click or drag over them)"
            >
              <EraserIcon /> Erase
            </Button>
          </div>
        )}
        {view !== "list" && (
          <select
            aria-label="Note shape"
            className="h-8 rounded-md border bg-card px-2 text-sm"
            value={shape}
            onChange={(e) => setShape(e.target.value as NoteShape)}
          >
            <option value="bar">Bars</option>
            <option value="triangle">Triangles (hits)</option>
            <option value="diamond">Diamonds (hits)</option>
          </select>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={snapOn}
          className={toggle(snapOn)}
          onClick={() => setSnapOn((s) => !s)}
          title="Snap notes to the grid"
        >
          <MagnetIcon /> Snap
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => setDialog("quantize")}
          data-tour="midi-quantize"
        >
          Quantize…
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => commit(unquantizeNotes(take.notes, ids()))}
          title="Back to how the notes were played"
        >
          Unquantize
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => commit(freezeQuantize(take.notes))}
          title="Keep the quantized timing; forget how the notes were played"
        >
          Freeze
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={() => setDialog("humanize")}>
          Humanize…
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={() => setDialog("transpose")}>
          Transpose…
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={selected.size === 0}
          onClick={() => setDialog("properties")}
        >
          Properties…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={stepInput}
          className={toggle(stepInput)}
          onClick={() => {
            setStepInput((s) => !s);
            setStepMs(cursorClipMs);
          }}
          title="Step input: F1 to F12 add a note and move on by the note length"
        >
          <KeyboardMusicIcon /> Step input
        </Button>
        <Button variant="ghost" size="sm" className="h-8" onClick={() => onEffects(index)}>
          Effects
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => void importMidiOntoLane(lanes, lane)}
        >
          Import MIDI…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => void exportLaneMidi(lanes, lane, song)}
        >
          Export MIDI…
        </Button>
        {onWriteTab && (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => onWriteTab(clip.id)}>
            Write into the tab
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Stop every note (panic)"
          title="Stop every note (panic)"
          onClick={() => void midiPanic().catch(() => undefined)}
        >
          <OctagonXIcon />
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums" aria-live="off">
          {pointer
            ? `${formatMs(pointer.ms - clipStartMs)} · ${pointer.pitch === null ? "" : rowName(pointer.pitch, view === "drums", names)}`
            : `${take.notes.length} notes`}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() => setPxPerMs((z) => Math.max(MIN_PX_PER_MS, z / 1.25))}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          onClick={() => setPxPerMs((z) => Math.min(MAX_PX_PER_MS, z * 1.25))}
        >
          <ZoomInIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close the MIDI editor" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      {view === "list" ? (
        <EventList
          notes={take.notes}
          cc={take.cc}
          selected={selected}
          cursorMs={cursorClipMs}
          formatMs={formatMs}
          onSelect={select}
          onNotes={(notes) => commit(notes)}
          onCc={commitCc}
          onAdd={(at) =>
            commit([
              ...take.notes,
              {
                id: newId(),
                startMs: at,
                lenMs: Math.min(stepLen(clipStartMs + at), clipMs - at),
                pitch: stepBase,
                vel: 100,
                chan: channel,
              },
            ])
          }
        />
      ) : (
        <>
          <div
            ref={scroller}
            className="relative min-h-0 flex-1 overflow-auto"
            onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
            onWheel={(e) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              setPxPerMs((z) =>
                Math.min(
                  MAX_PX_PER_MS,
                  Math.max(MIN_PX_PER_MS, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)),
                ),
              );
            }}
          >
            <div className="flex" style={{ width: KEYS_WIDTH + width }}>
              <div
                className="sticky left-0 z-20 shrink-0 border-r bg-card"
                style={{ width: KEYS_WIDTH }}
              >
                <div className="sticky top-0 z-10 h-6 border-b bg-card" />
                <KeyColumn
                  rows={rows}
                  rowHeight={rowHeight}
                  drums={view === "drums"}
                  names={names}
                  onPlay={(p) => {
                    audition(p, 100);
                    setStepBase(p);
                  }}
                />
              </div>
              <div className="relative">
                <Ruler
                  lines={lines}
                  view={editorView}
                  width={width}
                  onSeek={(ms) => lanes.setEditCursorMs(snap(ms))}
                />
                <PianoRoll
                  view={editorView}
                  width={width}
                  notes={shownNotes}
                  ghost={quantized ? take.notes : undefined}
                  selected={selected}
                  clipStartMs={clipStartMs}
                  clipMs={clipMs}
                  lines={lines}
                  tool={tool}
                  shape={shape}
                  color={color}
                  defaultLenMs={defaultLenMs}
                  snap={snap}
                  onSelect={select}
                  onChange={onRollChange}
                  onAudition={audition}
                  onPointerTime={setPointer}
                />
                <CursorLine x={xOf(editorView, lanes.editCursorMs)} />
                {stepInput && <CursorLine x={xOf(editorView, clipStartMs + stepMs)} step />}
                {playhead && (
                  <PlayheadLine store={playhead} audio={audio} song={song} view={editorView} />
                )}
              </div>
            </div>
          </div>
          <div className="shrink-0 overflow-hidden border-t">
            {controllers.map((kind, i) => (
              <div key={`${kind.type}-${i}`} className="flex">
                <div
                  className="flex shrink-0 items-center gap-1 border-r bg-card px-1"
                  style={{ width: KEYS_WIDTH }}
                >
                  <ControllerPicker
                    kind={kind}
                    onChange={(next) =>
                      setControllers((c) => c.map((k, j) => (j === i ? next : k)))
                    }
                  />
                  {controllers.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove the ${controllerLabel(kind)} lane`}
                      onClick={() => setControllers((c) => c.filter((_, j) => j !== i))}
                    >
                      <MinusIcon />
                    </Button>
                  )}
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div style={{ transform: `translateX(${-scrollLeft}px)`, width }}>
                    <ControllerLane
                      kind={kind}
                      view={editorView}
                      width={width}
                      height={56}
                      clipStartMs={clipStartMs}
                      notes={take.notes}
                      cc={take.cc}
                      selected={selected}
                      channel={view === "drums" ? DRUM_CHANNEL : channel}
                      snap={snap}
                      color={color}
                      onNotes={(notes) => commit(notes)}
                      onCc={commitCc}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t px-2 py-1 text-sm">
        <GridPicker grid={grid} onChange={setGrid} />
        <label className="flex items-center gap-1.5">
          Note length
          <select
            aria-label="Note length"
            className="h-8 rounded-md border bg-card px-2 text-sm"
            value={lengthMode}
            onChange={(e) => setLengthMode(e.target.value as "grid" | "last")}
          >
            <option value="grid">Grid</option>
            <option value="last">Last drawn note</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Channel
          <select
            aria-label="Channel for new notes"
            className="h-8 rounded-md border bg-card px-2 text-sm"
            value={channel}
            onChange={(e) => setChannel(Number(e.target.value))}
          >
            {Array.from({ length: 16 }, (_, c) => (
              <option key={c} value={c}>
                {c + 1}
                {c === DRUM_CHANNEL ? " (drums)" : ""}
              </option>
            ))}
          </select>
        </label>
        {view === "drums" && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={hideUnused}
              onChange={(e) => setHideUnused(e.target.checked)}
            />
            Hide unused drums
          </label>
        )}
        {view !== "list" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => setControllers((c) => [...c, { type: "cc", cc: 1 }])}
          >
            <PlusIcon /> Controller lane
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {selected.size > 0
            ? `${selected.size} selected`
            : "Q quantize · S split · J join · L legato · M mute · I insert"}
        </span>
      </div>

      <QuantizeDialog
        open={dialog === "quantize"}
        onOpenChange={(open) => setDialog(open ? "quantize" : null)}
        grid={grid}
        selectedCount={selected.size}
        onPreview={setPreview}
        onApply={quantize}
      />
      <HumanizeDialog
        open={dialog === "humanize"}
        onOpenChange={(open) => setDialog(open ? "humanize" : null)}
        selectedCount={selected.size}
        onApply={(amount) => commit(humanizeNotes(take.notes, amount, Math.random, ids()))}
      />
      <TransposeDialog
        open={dialog === "transpose"}
        onOpenChange={(open) => setDialog(open ? "transpose" : null)}
        selectedCount={selected.size}
        onApply={(semitones, scale) => {
          const moved = transposeNotes(take.notes, ids(), semitones);
          commit(
            scale
              ? moved.map((n) =>
                  !selected.size || selected.has(n.id)
                    ? { ...n, pitch: snapPitchToScale(n.pitch, scale.root, scale.steps) }
                    : n,
                )
              : moved,
          );
        }}
      />
      <NotePropertiesDialog
        open={dialog === "properties"}
        onOpenChange={(open) => setDialog(open ? "properties" : null)}
        notes={selectedNotes}
        onApply={applyProperties}
      />
    </section>
  );
}

/** The piano keys (or drum names) beside the grid: click one to hear it. */
function KeyColumn({
  rows,
  rowHeight,
  drums,
  names,
  onPlay,
}: {
  rows: readonly number[];
  rowHeight: number;
  drums: boolean;
  names: Readonly<Record<number, string>>;
  onPlay: (pitch: number) => void;
}) {
  return (
    <div role="group" aria-label={drums ? "Drums" : "Piano keys"} data-testid="midi-keys">
      {rows.map((pitch) => {
        const black = !drums && isBlackKey(pitch);
        return (
          <button
            key={pitch}
            type="button"
            tabIndex={-1}
            onClick={() => onPlay(pitch)}
            title={rowName(pitch, drums, names)}
            className={cn(
              "flex w-full items-center truncate border-b border-foreground/10 px-1.5 text-left text-[10px] leading-none",
              black ? "bg-foreground/80 text-background" : "bg-card",
              !drums && pitch % 12 === 0 && "font-semibold",
            )}
            style={{ height: rowHeight }}
          >
            {drums || pitch % 12 === 0 || rowHeight >= 16 ? rowName(pitch, drums, names) : ""}
          </button>
        );
      })}
    </div>
  );
}

/** Bar numbers over the grid; a click puts the position line there. */
function Ruler({
  lines,
  view,
  width,
  onSeek,
}: {
  lines: ReturnType<typeof gridLines>;
  view: View;
  width: number;
  onSeek: (ms: number) => void;
}) {
  return (
    <div
      role="presentation"
      className="sticky top-0 z-10 h-6 cursor-pointer border-b bg-card text-[10px]"
      style={{ width }}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        onSeek(view.originMs + (e.clientX - box.left) / view.pxPerMs);
      }}
    >
      {lines
        .filter((l) => l.kind === "bar")
        .map((l) => (
          <span
            key={l.ms}
            className="absolute top-1 border-l border-foreground/40 pl-1"
            style={{ left: xOf(view, l.ms) }}
          >
            {l.bar}
          </span>
        ))}
    </div>
  );
}

function CursorLine({ x, step }: { x: number; step?: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-testid={step ? "midi-step-cursor" : "midi-cursor"}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-px",
        step ? "bg-amber-500" : "bg-primary",
      )}
      style={{ left: x }}
    />
  );
}

/** Where playback is, moving on its own (only this line redraws). */
function PlayheadLine({
  store,
  audio,
  song,
  view,
}: {
  store: PlayheadStore;
  audio: AudioLanesController["audio"];
  song: SongGrid;
  view: View;
}) {
  const bar = usePlayheadBar(store);
  const ms = timelineMsAtBar(audio, song, bar);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-foreground/70"
      style={{ left: xOf(view, ms) }}
    />
  );
}

const CONTROLLER_CHOICES: readonly ControllerKind[] = [
  { type: "velocity" },
  { type: "bend" },
  { type: "pressure" },
  ...Array.from({ length: 128 }, (_, cc) => ({ type: "cc" as const, cc })),
];

const kindKey = (k: ControllerKind) => (k.type === "cc" ? `cc:${k.cc}` : k.type);

/** Which controller a lane shows: velocity, pitch bend, pressure or any CC number. */
function ControllerPicker({
  kind,
  onChange,
}: {
  kind: ControllerKind;
  onChange: (kind: ControllerKind) => void;
}) {
  return (
    <select
      aria-label="Controller lane"
      className="h-7 min-w-0 flex-1 rounded-md border bg-card px-1 text-xs"
      value={kindKey(kind)}
      onChange={(e) => {
        const [type, cc] = e.target.value.split(":");
        onChange(type === "cc" ? { type: "cc", cc: Number(cc) } : ({ type } as ControllerKind));
      }}
    >
      {CONTROLLER_CHOICES.map((k) => (
        <option key={kindKey(k)} value={kindKey(k)}>
          {controllerLabel(k)}
        </option>
      ))}
    </select>
  );
}
