import {
  ArrowLeftIcon,
  AudioWaveformIcon,
  CircleIcon,
  DownloadIcon,
  KeyboardIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { ClipView, type ClipDrag } from "@/components/audio-lanes/clip-view";
import { CLIP_SHORTCUTS, handleClipKey } from "@/components/audio-lanes/clip-keys";
import { LaneContextMenu } from "@/components/audio-lanes/lane-context-menu";
import { SelectedClipsPanel } from "@/components/audio-lanes/multi-clip-properties";
import { SpectrogramView } from "@/components/audio-lanes/spectrogram-view";
import type { AudioLanesController, SnapMode } from "@/components/audio-lanes/use-audio-lanes";
import { gridStepMs } from "@/components/audio-lanes/use-audio-lanes";
import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { Toggle } from "@/components/ui/toggle";
import {
  deleteRange,
  findClip,
  moveClip,
  moveRange,
  splitRange,
  trimClip,
  updateLane,
} from "@/lib/audio-lanes/edits";
import { MAX_BUSES, clipEndMs, newId } from "@/lib/audio-lanes/model";
import { timelineMsAtBar, type SongGrid } from "@/lib/audio-lanes/sync";
import { usePlayheadBar, type PlayheadStore } from "@/lib/score/playhead";
import { laneColor } from "@/lib/score/track-colors";
import type { AudioLane, RippleMode } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const HEADER_PX = 224;

export interface StudioActions {
  playPause: () => void;
  record: () => void;
  effects: (laneIndex: number) => void;
  /** Renders each lane to its own file. */
  renderLanes: () => void;
  /** Renders the mix between two timeline points. */
  renderRange: (startMs: number, endMs: number) => void;
  close: () => void;
}

/**
 * The studio (layout 2B): every lane in audio time with transport, snap, ripple, section markers,
 * a range selection for edits across lanes, folders, buses and sends, the clip properties panel,
 * and a spectrogram with loudness for the selected clip.
 */
export function StudioView({
  lanes,
  grid,
  markers,
  playhead,
  playing,
  position,
  actions,
}: {
  lanes: AudioLanesController;
  grid: SongGrid;
  /** Section names and where they start on the timeline. */
  markers: readonly { ms: number; name: string }[];
  playhead?: PlayheadStore;
  playing: boolean;
  /** "5.3 · 0:09.4" */
  position: string;
  actions: StudioActions;
}) {
  const { audio, apply } = lanes;
  const [pps, setPps] = useState(40);
  const [range, setRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [rangeLanes, setRangeLanes] = useState<readonly string[] | null>(null);
  const [spectrogram, setSpectrogram] = useState(false);
  /** Bumped by F2 or a double-click on a clip: the properties panel takes the focus. */
  const [panelFocus, setPanelFocus] = useState(0);
  const rulerDrag = useRef<number | null>(null);
  const toX = (ms: number) => (ms / 1000) * pps;
  const toMs = (x: number) => (x / pps) * 1000;
  const songEnd = timelineMsAtBar(audio, grid, grid.barTimes.length);
  const end = Math.max(songEnd, ...audio.lanes.flatMap((l) => l.clips.map(clipEndMs))) + 4000;
  const shown = audio.lanes.filter(
    (l) => !l.parent || !audio.lanes.find((f) => f.id === l.parent)?.collapsed,
  );
  const playable = audio.lanes.filter((l) => !l.folder).map((l) => l.id);
  const inRange = rangeLanes ?? playable;
  const selected = lanes.selection.length === 1 ? findClip(audio, lanes.selection[0]!) : null;

  const rulerMs = (e: PointerEvent<HTMLDivElement>) =>
    lanes.snapTo(toMs(e.clientX - e.currentTarget.getBoundingClientRect().left));
  const openProperties = (clipId: string) => {
    if (!lanes.selection.includes(clipId)) lanes.select([clipId]);
    setPanelFocus((n) => n + 1);
  };
  const drop = (drag: ClipDrag) => {
    if (drag.kind === "move")
      apply((a) => moveClip(a, drag.clipId, drag.startMs, drag.laneId ?? undefined));
    else apply((a) => trimClip(a, drag.clipId, drag.edge, drag.atMs));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && actions.close()}>
      <DialogContent
        size="full"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="studio"
        className="h-[calc(100dvh-1rem)] max-h-none max-w-[calc(100%-1rem)] gap-0 bg-background p-0 sm:max-w-[calc(100%-1rem)]"
      >
        <header className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2">
          <Button variant="outline" size="sm" onClick={actions.close}>
            <ArrowLeftIcon /> Back to score
          </Button>
          <DialogTitle className="ml-2 text-base font-semibold">Studio</DialogTitle>
          <span className="flex-1" />
          <Button
            size="icon"
            className="rounded-full"
            aria-label={playing ? "Pause" : "Play"}
            onClick={actions.playPause}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="rounded-full text-red-600"
            aria-label="Record audio"
            onClick={actions.record}
          >
            <CircleIcon className="fill-current" />
          </Button>
          <span className="min-w-36 px-2 text-sm tabular-nums" aria-label="Position">
            {position}
          </span>
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Snap
            <select
              value={lanes.snap}
              onChange={(e) => lanes.setSnap(e.target.value as SnapMode)}
              className="h-8 rounded-md border bg-background px-1.5 text-foreground"
            >
              <option value="bar">Bar</option>
              <option value="beat">Beat</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Ripple
            <select
              value={audio.ripple}
              onChange={(e) => apply((a) => ({ ...a, ripple: e.target.value as RippleMode }))}
              className="h-8 rounded-md border bg-background px-1.5 text-foreground"
            >
              <option value="off">Off</option>
              <option value="lane">This lane</option>
              <option value="all">All lanes</option>
            </select>
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Undo"
            disabled={!lanes.canUndo}
            onClick={lanes.undo}
          >
            <Undo2Icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Redo"
            disabled={!lanes.canRedo}
            onClick={lanes.redo}
          >
            <Redo2Icon />
          </Button>
          <Button variant="outline" size="sm" onClick={lanes.commands.addLane}>
            <PlusIcon /> Lane
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={audio.buses.length >= MAX_BUSES}
            onClick={() =>
              apply((a) => ({
                ...a,
                buses: [
                  ...a.buses,
                  {
                    id: newId(),
                    name: `Bus ${a.buses.length + 1}`,
                    volume: 0.8,
                    mute: false,
                    effects: [],
                  },
                ],
              }))
            }
          >
            <PlusIcon /> Bus
          </Button>
          <Button
            variant={spectrogram ? "default" : "outline"}
            size="sm"
            aria-pressed={spectrogram}
            onClick={() => setSpectrogram((s) => !s)}
          >
            <AudioWaveformIcon /> Spectrogram
          </Button>
          <Button variant="outline" size="sm" onClick={actions.renderLanes}>
            <DownloadIcon /> Render lanes
          </Button>
          <ShortcutsPopover />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            Zoom
            <input
              type="range"
              min={10}
              max={300}
              value={pps}
              onChange={(e) => setPps(e.currentTarget.valueAsNumber)}
              aria-label="Zoom"
              className="w-24"
            />
          </label>
        </header>
        {range && (
          <div
            className="flex flex-wrap items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-sm"
            data-testid="range-bar"
          >
            <span className="tabular-nums">
              Range {(range.startMs / 1000).toFixed(2)} s – {(range.endMs / 1000).toFixed(2)} s on{" "}
              {inRange.length} lanes
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => apply((a) => splitRange(a, inRange, range.startMs, range.endMs))}
            >
              Split at the edges
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => apply((a) => deleteRange(a, inRange, range.startMs, range.endMs))}
            >
              Delete range
            </Button>
            {([-1, 1] as const).map((d) => (
              <Button
                key={d}
                variant="outline"
                size="sm"
                onClick={() => {
                  const step = d * gridStepMs(grid, range.startMs, false);
                  apply((a) => moveRange(a, inRange, range.startMs, range.endMs, step));
                  setRange({ startMs: range.startMs + step, endMs: range.endMs + step });
                }}
              >
                Move {d < 0 ? "earlier" : "later"} a beat
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => actions.renderRange(range.startMs, range.endMs)}
            >
              Render range
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRange(null)}>
              Clear
            </Button>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-auto">
            <div className="relative" style={{ width: HEADER_PX + toX(end) }}>
              <div className="sticky top-0 z-30 flex h-10 border-b bg-card">
                <div
                  className="sticky left-0 z-10 shrink-0 border-r bg-card"
                  style={{ width: HEADER_PX }}
                />
                <div
                  className="relative flex-1 cursor-text"
                  data-testid="studio-ruler"
                  onPointerDown={(e) => {
                    rulerDrag.current = rulerMs(e);
                    setRange(null);
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (rulerDrag.current === null) return;
                    const at = rulerMs(e);
                    if (Math.abs(at - rulerDrag.current) > 1)
                      setRange({
                        startMs: Math.min(at, rulerDrag.current),
                        endMs: Math.max(at, rulerDrag.current),
                      });
                  }}
                  onPointerUp={(e) => {
                    if (rulerDrag.current !== null && !range) lanes.setEditCursorMs(rulerMs(e));
                    rulerDrag.current = null;
                  }}
                >
                  {markers.map((m) => (
                    <span
                      key={`${m.ms}-${m.name}`}
                      className="absolute top-1 rounded bg-muted px-1.5 text-xs"
                      style={{ left: toX(m.ms) }}
                    >
                      {m.name}
                    </span>
                  ))}
                  {grid.barTimes.map((_, b) => (
                    <span
                      key={b}
                      aria-hidden="true"
                      className="absolute bottom-0 h-3 border-l text-[10px] text-muted-foreground"
                      style={{ left: toX(timelineMsAtBar(audio, grid, b)) }}
                    >
                      {b % 4 === 0 ? b + 1 : ""}
                    </span>
                  ))}
                  {range && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-3 bg-primary/50"
                      style={{ left: toX(range.startMs), width: toX(range.endMs - range.startMs) }}
                    />
                  )}
                </div>
              </div>
              {shown.map((lane) => (
                <StudioLane
                  key={lane.id}
                  lanes={lanes}
                  lane={lane}
                  index={audio.lanes.indexOf(lane)}
                  toX={toX}
                  toMs={toMs}
                  inRange={inRange.includes(lane.id)}
                  onRangeToggle={() =>
                    setRangeLanes((current) => {
                      const list = current ?? playable;
                      return list.includes(lane.id)
                        ? list.filter((id) => id !== lane.id)
                        : [...list, lane.id];
                    })
                  }
                  onEffects={actions.effects}
                  onDrop={drop}
                  onOpenProperties={openProperties}
                  range={range}
                />
              ))}
              {audio.buses.map((bus) => (
                <div
                  key={bus.id}
                  className="flex h-12 border-b bg-muted/30"
                  data-testid={`bus-${bus.id}`}
                >
                  <div
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r bg-card px-3"
                    style={{ width: HEADER_PX }}
                  >
                    <span className="truncate text-sm font-medium">{bus.name}</span>
                    <Toggle
                      size="sm"
                      variant="outline"
                      pressed={bus.mute}
                      onPressedChange={(mute) =>
                        apply((a) => ({
                          ...a,
                          buses: a.buses.map((b) => (b.id === bus.id ? { ...b, mute } : b)),
                        }))
                      }
                      aria-label={`Mute ${bus.name}`}
                      className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
                    >
                      M
                    </Toggle>
                    <LabeledSlider
                      label={`Volume, ${bus.name}`}
                      valueText={`${Math.round(bus.volume * 100)}%`}
                      value={bus.volume}
                      onValueChange={(volume) =>
                        apply((a) => ({
                          ...a,
                          buses: a.buses.map((b) => (b.id === bus.id ? { ...b, volume } : b)),
                        }))
                      }
                    />
                  </div>
                  <p className="self-center px-3 text-xs text-muted-foreground">
                    Lanes send to this bus from their Sends button.
                  </p>
                </div>
              ))}
              {playhead && (
                <StudioPlayhead
                  store={playhead}
                  toX={(bar) => HEADER_PX + toX(timelineMsAtBar(audio, grid, bar))}
                />
              )}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-10 bottom-0 z-20 border-l border-dashed border-primary"
                style={{ left: HEADER_PX + toX(lanes.editCursorMs) }}
              />
            </div>
          </div>
          <SelectedClipsPanel lanes={lanes} focusRequest={panelFocus} />
        </div>
        {spectrogram && selected && <SpectrogramView clip={selected.clip} />}
        {spectrogram && !selected && (
          <p className="border-t p-3 text-sm text-muted-foreground">
            Select one clip to see its spectrogram and loudness.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StudioLane({
  lanes,
  lane,
  index,
  toX,
  toMs,
  inRange,
  onRangeToggle,
  onEffects,
  onDrop,
  onOpenProperties,
  range,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  index: number;
  toX: (ms: number) => number;
  toMs: (x: number) => number;
  inRange: boolean;
  onRangeToggle: () => void;
  onEffects: (index: number) => void;
  onDrop: (drag: ClipDrag) => void;
  onOpenProperties: (clipId: string) => void;
  range: { startMs: number; endMs: number } | null;
}) {
  const { apply } = lanes;
  const color = laneColor(index, lane.color);
  const update = (patch: Partial<AudioLane>) => apply((a) => updateLane(a, lane.id, patch));
  return (
    <div
      className={cn("flex border-b", lane.folder ? "h-9 bg-muted/40" : "h-20")}
      data-testid={`studio-lane-${lane.id}`}
    >
      <div
        className={cn(
          "sticky left-0 z-10 flex shrink-0 flex-col justify-center gap-1 border-r bg-card px-3",
          lane.parent && "pl-6",
        )}
        style={{ width: HEADER_PX, boxShadow: `inset 3px 0 0 ${color}` }}
      >
        <div className="flex items-center gap-1.5">
          {lane.folder && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded={!lane.collapsed}
              aria-label={`${lane.collapsed ? "Open" : "Close"} ${lane.name}`}
              onClick={() => update({ collapsed: !lane.collapsed })}
            >
              {lane.collapsed ? "▸" : "▾"}
            </Button>
          )}
          <span className="truncate text-sm font-semibold">{lane.name}</span>
          {lane.group > 0 && <span className="rounded bg-muted px-1 text-[10px]">group</span>}
        </div>
        <div className="flex items-center gap-1">
          <Toggle
            size="sm"
            variant="outline"
            pressed={lane.mute}
            onPressedChange={(mute) => update({ mute })}
            aria-label={`Mute ${lane.name}`}
            className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
          >
            M
          </Toggle>
          <Toggle
            size="sm"
            variant="outline"
            pressed={lane.solo}
            onPressedChange={(solo) => update({ solo })}
            aria-label={`Solo ${lane.name}`}
            className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
          >
            S
          </Toggle>
          {!lane.folder && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-1.5 text-xs"
                onClick={() => onEffects(index)}
              >
                FX{lane.effects.length ? ` ${lane.effects.length}` : ""}
              </Button>
              <SendsPopover lanes={lanes} lane={lane} />
              <Toggle
                size="sm"
                variant="outline"
                pressed={inRange}
                onPressedChange={onRangeToggle}
                aria-label={`Range: ${lane.name} in range edits`}
                className="h-6 px-1.5 text-[10px]"
              >
                Range
              </Toggle>
              <Toggle
                size="sm"
                variant="outline"
                pressed={lane.autoBypass}
                onPressedChange={(autoBypass) => update({ autoBypass })}
                aria-label={`Auto bypass: effects of ${lane.name} stop while silent`}
                title="Effects stop while the lane is silent"
                className="h-6 px-1.5 text-[10px]"
              >
                Auto
              </Toggle>
            </>
          )}
        </div>
      </div>
      {!lane.folder && (
        <LaneContextMenu lanes={lanes} lane={lane} toMs={toMs}>
          <div
            role="presentation"
            className="relative flex-1"
            data-lane-id={lane.id}
            onPointerDown={(e) => {
              if (e.target !== e.currentTarget) return;
              lanes.setEditCursorMs(
                lanes.snapTo(toMs(e.clientX - e.currentTarget.getBoundingClientRect().left)),
              );
              lanes.select([]);
            }}
          >
            {range && inRange && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 bg-primary/15"
                style={{ left: toX(range.startMs), width: toX(range.endMs - range.startMs) }}
              />
            )}
            {lane.clips.map((clip) => (
              <ClipView
                key={clip.id}
                clip={clip}
                laneName={lane.name}
                color={color}
                info={lanes.infos.get(clip.takes[clip.take]?.sourceId ?? "")}
                missing={clip.takes.some((t) => lanes.missing.has(t.sourceId))}
                selected={lanes.selection.includes(clip.id)}
                toX={toX}
                toMs={toMs}
                snap={lanes.snapTo}
                onSelect={(additive) =>
                  lanes.select(additive ? [...new Set([...lanes.selection, clip.id])] : [clip.id])
                }
                onDrop={onDrop}
                onKey={(event) =>
                  handleClipKey(
                    event,
                    lanes,
                    clip.id,
                    lane.id,
                    () => undefined,
                    () => onOpenProperties(clip.id),
                  )
                }
                onOpen={() => onOpenProperties(clip.id)}
                onCursor={lanes.setEditCursorMs}
              />
            ))}
            {lane.clips.some((c) => c.takes.length > 1) && (
              <span className="pointer-events-none absolute right-1 bottom-0.5 text-[10px] text-muted-foreground">
                takes
              </span>
            )}
          </div>
        </LaneContextMenu>
      )}
      {lane.folder && <div className="flex-1" aria-hidden="true" />}
    </div>
  );
}

function SendsPopover({ lanes, lane }: { lanes: AudioLanesController; lane: AudioLane }) {
  const { apply, audio } = lanes;
  const level = (bus: string) => lane.sends.find((s) => s.bus === bus)?.level ?? 0;
  const setLevel = (bus: string, value: number) =>
    apply((a) =>
      updateLane(a, lane.id, {
        sends: [
          ...lane.sends.filter((s) => s.bus !== bus),
          ...(value > 0 ? [{ bus, level: value }] : []),
        ],
      }),
    );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-xs"
          disabled={!audio.buses.length}
          title={audio.buses.length ? "Sends" : "Add a bus first"}
        >
          Sends
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" aria-label={`Sends of ${lane.name}`}>
        <div className="flex flex-col gap-2">
          {audio.buses.map((bus) => (
            <LabeledSlider
              key={bus.id}
              label={`Send to ${bus.name}`}
              valueText={`${Math.round(level(bus.id) * 100)}%`}
              value={level(bus.id)}
              onValueChange={(v) => setLevel(bus.id, v)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ShortcutsPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Clip shortcuts">
          <KeyboardIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" aria-label="Clip shortcuts">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {CLIP_SHORTCUTS.map((s) => (
            <div key={s.keys} className="contents">
              <dt className="font-mono text-xs">{s.keys}</dt>
              <dd>{s.action}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function StudioPlayhead({ store, toX }: { store: PlayheadStore; toX: (bar: number) => number }) {
  const bar = usePlayheadBar(store);
  return (
    <span
      aria-hidden="true"
      data-testid="position-line"
      className="pointer-events-none absolute top-10 bottom-0 z-20 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_var(--background)]"
      style={{ left: toX(bar) }}
    >
      <span className="absolute -top-px left-1/2 size-3 -translate-x-1/2 bg-primary [clip-path:polygon(0_0,100%_0,50%_100%)]" />
    </span>
  );
}
