import {
  FolderOpenIcon,
  MaximizeIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { EditorTimeline } from "@/components/audio-lanes/editor-timeline";
import { LanePlaybackNotice } from "@/components/audio-lanes/lane-playback-notice";
import { EqPopover } from "@/components/audio/eq-popover";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { useMarkers } from "@/components/audio-lanes/use-markers";
import { useTimelineZoom } from "@/components/audio-lanes/use-timeline-zoom";
import { ZoomControls } from "@/components/audio-lanes/zoom-controls";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Knob } from "@/components/ui/knob";
import { Switch } from "@/components/ui/switch";
import { removeLane, updateLane } from "@/lib/audio-lanes/edits";
import { MAX_CENTS, MAX_SEMITONES } from "@/lib/audio-lanes/model";
import { clearSync, resetPadding, timelineMsAtBar, type SongGrid } from "@/lib/audio-lanes/sync";
import { selectionSpan, songSpan } from "@/lib/audio-lanes/zoom";
import { FILTER_LABELS } from "@/lib/audio/audio-track";
import type { PlayheadStore } from "@/lib/score/playhead";
import { laneColor } from "@/lib/score/track-colors";
import type { AudioLane, BackingFilter, SyncPoint } from "@/lib/tauri";

/** Editor zoom range, pixels per second. */
const MIN_ZOOM = 10;
const MAX_ZOOM = 400;
/** Editor height range, pixels. */
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 520;

const FILTERS = Object.keys(FILTER_LABELS) as BackingFilter[];

export interface LaneEditorActions {
  /** The song's sync points from the score's tempo changes (`add`: keep the existing ones). */
  syncFromScoreTempo: (mode: "replace" | "add") => SyncPoint[];
  /** Writes tempo changes into the score so it follows the audio. */
  tempoFromSync: () => void;
  /** Sync points on every bar from the beats found in the lane's first clip. */
  syncFromBeats: (laneId: string) => void;
  replaceFile: (laneId: string) => void;
  extract: (sourceId: string, asWav: boolean) => void;
  addBar: () => void;
  effects: (laneIndex: number) => void;
  openStudio: () => void;
  close: () => void;
}

/**
 * The lane editor docked under the score (layout 2A): one lane in audio time, with the score's
 * grid over it. The toolbar has the on switch, replace and remove, zoom, the tasks menu, the
 * filter and the pitch knobs; the score stays visible above.
 */
export function LaneEditorDock({
  lanes,
  lane,
  index,
  grid,
  scoreBpmAt,
  playhead,
  playing,
  selectedBars,
  onSelectBars,
  onSeekBar,
  actions,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  index: number;
  grid: SongGrid;
  scoreBpmAt: (bar: number) => number;
  playhead?: PlayheadStore;
  playing: boolean;
  selectedBars: { start: number; end: number } | null;
  onSelectBars: (start: number, end: number) => void;
  onSeekBar: (bar: number, loop: boolean) => void;
  actions: LaneEditorActions;
}) {
  const { apply, audio } = lanes;
  const scroller = useRef<HTMLDivElement>(null);
  const userMarkers = useMarkers(lanes);
  const zoomer = useTimelineZoom({
    initial: 60,
    limits: { min: MIN_ZOOM, max: MAX_ZOOM },
    song: songSpan(audio, timelineMsAtBar(audio, grid, grid.barTimes.length)),
    selection: selectionSpan(
      { ...audio, lanes: [lane] },
      lanes.selection,
      selectedBars && {
        startMs: timelineMsAtBar(audio, grid, selectedBars.start),
        endMs: timelineMsAtBar(audio, grid, selectedBars.end + 1),
      },
    ),
    lineMs: lanes.lineMs,
  });
  const zoom = zoomer.pxPerSecond;
  const { attachScroller } = zoomer;
  // The editor's follow-playback needs the scroller as a ref too: one element, two holders.
  const holdScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      attachScroller(el);
    },
    [attachScroller],
  );
  const [height, setHeight] = useState(280);
  const [byHand, setByHand] = useState(false);
  const autoScrolled = useRef(false);
  const update = (patch: Partial<AudioLane>) => apply((a) => updateLane(a, lane.id, patch));
  const color = laneColor(index, lane.color);
  const sources = audio.sources.filter((s) =>
    lane.clips.some((c) => c.takes.some((t) => t.sourceId === s.id)),
  );

  // Follows the playhead while playing, until the user scrolls by hand; a new play follows again.
  const [wasPlaying, setWasPlaying] = useState(playing);
  if (wasPlaying !== playing) {
    setWasPlaying(playing);
    if (!playing) setByHand(false);
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the marker and zoom keys bubble up from the focused controls inside; the section takes none itself
    <section
      aria-label={`Lane editor: ${lane.name}`}
      data-testid="lane-editor"
      className="flex shrink-0 flex-col border-t bg-card"
      style={{ height }}
      tabIndex={-1}
      onKeyDown={(e) => {
        zoomer.onKeyDown(e);
        userMarkers.onKeyDown(e);
      }}
    >
      <button
        type="button"
        aria-label={`Resize the lane editor (${height} px): drag, or use the up and down arrows`}
        className="h-1.5 w-full shrink-0 cursor-ns-resize bg-muted outline-none focus-visible:bg-primary/40"
        onPointerDown={(e) => {
          const startY = e.clientY;
          const startH = height;
          const move = (ev: PointerEvent) =>
            setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH - (ev.clientY - startY))));
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") setHeight((h) => Math.min(MAX_HEIGHT, h + 20));
          if (e.key === "ArrowDown") setHeight((h) => Math.max(MIN_HEIGHT, h - 20));
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <Switch
          checked={lane.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
          aria-label={`${lane.name} on`}
        />
        <span
          aria-hidden="true"
          className="size-2.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="max-w-48 truncate text-sm font-semibold">{lane.name}</span>
        <LanePlaybackNotice playback={lanes.playback} laneName={lane.name} />
        <Button variant="outline" size="sm" onClick={() => actions.replaceFile(lane.id)}>
          <FolderOpenIcon /> Replace file
        </Button>
        <Button variant="outline" size="sm" onClick={() => apply((a) => removeLane(a, lane.id))}>
          <Trash2Icon /> Remove
        </Button>
        <ZoomControls zoom={zoomer} />
        <TasksMenu
          lanes={lanes}
          lane={lane}
          sources={sources}
          grid={grid}
          actions={actions}
          onZoom={zoomer.setPxPerSecond}
        />
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Filter
          <select
            value={lane.filter}
            onChange={(e) => update({ filter: e.target.value as BackingFilter })}
            className="h-7 rounded-md border bg-background px-1.5 text-sm text-foreground"
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {FILTER_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <Knob
          label="Semitones"
          valueText={`${lane.semitones > 0 ? "+" : ""}${lane.semitones}`}
          value={lane.semitones}
          min={-MAX_SEMITONES}
          max={MAX_SEMITONES}
          step={1}
          size="sm"
          onValueChange={(semitones) => update({ semitones: Math.round(semitones) })}
        />
        <Knob
          label="Cents"
          valueText={`${lane.cents > 0 ? "+" : ""}${lane.cents}`}
          value={lane.cents}
          min={-MAX_CENTS}
          max={MAX_CENTS}
          step={1}
          size="sm"
          onValueChange={(cents) => update({ cents: Math.round(cents) })}
        />
        <EqPopover name={lane.name} eq={lane.eq} onChange={(eq) => update({ eq })} />
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Effects of ${lane.name}`}
          onClick={() => actions.effects(index)}
        >
          <SlidersHorizontalIcon />
        </Button>
        <Button variant="outline" size="sm" onClick={actions.openStudio} data-tour="open-studio">
          <MaximizeIcon /> Studio
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the lane editor"
          onClick={actions.close}
        >
          <XIcon />
        </Button>
      </div>
      <div
        ref={holdScroller}
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={() => {
          // Following playback scrolls too: only the user's own scroll stops the following.
          if (autoScrolled.current) autoScrolled.current = false;
          else if (playing) setByHand(true);
        }}
      >
        <EditorTimeline
          lanes={lanes}
          lane={lane}
          color={color}
          grid={grid}
          pxPerSecond={zoom}
          scoreBpmAt={scoreBpmAt}
          playhead={playhead}
          markers={userMarkers}
          follow={playing && !byHand}
          scroller={scroller}
          onAutoScroll={() => (autoScrolled.current = true)}
          selectedBars={selectedBars}
          onSelectBars={onSelectBars}
          onSeekBar={onSeekBar}
        />
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Add a bar to the song"
          title="Add a bar after the last one"
          className="sticky right-2 bottom-2 float-right"
          onClick={actions.addBar}
        >
          <PlusIcon />
        </Button>
        {byHand && playing && (
          <Button size="sm" className="sticky bottom-2 left-2" onClick={() => setByHand(false)}>
            Resume auto-scroll
          </Button>
        )}
      </div>
    </section>
  );
}

function TasksMenu({
  lanes,
  lane,
  sources,
  grid,
  actions,
  onZoom,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  sources: AudioLanesController["audio"]["sources"];
  grid: SongGrid;
  actions: LaneEditorActions;
  onZoom: (pxPerSecond: number) => void;
}) {
  const { apply } = lanes;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-tour="lane-tasks">
          <SettingsIcon /> Tasks
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Sync</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => apply((a) => clearSync(a))}>
          Clear sync points
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => apply((a) => resetPadding(a, grid))}>
          Reset padding
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => apply((a) => ({ ...a, sync: actions.syncFromScoreTempo("replace") }))}
        >
          Sync points from score tempo changes (replace)
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => apply((a) => ({ ...a, sync: actions.syncFromScoreTempo("add") }))}
        >
          Sync points from score tempo changes (add)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={actions.tempoFromSync}>
          Score tempo changes from sync points
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.syncFromBeats(lane.id)}>
          Sync points from detected beats
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Files</DropdownMenuLabel>
        {sources.map((s) => (
          <DropdownMenuCheckboxItem
            key={s.id}
            checked={s.embedded}
            onCheckedChange={(embedded) =>
              apply((a) => ({
                ...a,
                sources: a.sources.map((x) => (x.id === s.id ? { ...x, embedded: !!embedded } : x)),
              }))
            }
          >
            Embed “{s.name}” in the song
          </DropdownMenuCheckboxItem>
        ))}
        {sources.map((s) => (
          <DropdownMenuItem key={`x-${s.id}`} onSelect={() => actions.extract(s.id, false)}>
            Extract “{s.name}”…
          </DropdownMenuItem>
        ))}
        {sources.map((s) => (
          <DropdownMenuItem key={`w-${s.id}`} onSelect={() => actions.extract(s.id, true)}>
            Extract “{s.name}” as WAV…
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Zoom</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onZoom(20)}>Whole song</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom(60)}>Normal</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onZoom(200)}>Close up</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
