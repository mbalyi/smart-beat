import {
  AudioLinesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  MoreHorizontalIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";

import { ClipView, type ClipDrag } from "@/components/audio-lanes/clip-view";
import { handleClipKey } from "@/components/audio-lanes/clip-keys";
import { LaneContextMenu } from "@/components/audio-lanes/lane-context-menu";
import { LaneColorPopover } from "@/components/audio-lanes/lane-color-popover";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { LevelMeter } from "@/components/audio/level-meter";
import { LabeledSlider } from "@/components/labeled-slider";
import { PanControl } from "@/components/pan-control";
import { Playhead } from "@/components/playhead";
import { CONTROLS } from "@/components/shell/track-row-layout";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import {
  makeFolder,
  moveClip,
  moveLane,
  removeLane,
  trimClip,
  updateLane,
} from "@/lib/audio-lanes/edits";
import { clipEndMs } from "@/lib/audio-lanes/model";
import { barAtTimelineMs, timelineMsAtBar, type SongGrid } from "@/lib/audio-lanes/sync";
import { describeVolume } from "@/lib/score/mixer";
import type { PlayheadStore } from "@/lib/score/playhead";
import { laneColor } from "@/lib/score/track-colors";
import type { AudioLane } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * One audio lane in the track list (compact row): colour strip, name, on switch, mute and solo,
 * volume with its meter, pan, EQ, effects, colour and a menu; then its clips across the bar grid,
 * where clips are moved, trimmed and dropped, and a click sets the edit cursor.
 */
export function LaneRow({
  lanes,
  lane,
  index,
  barWidth,
  barCount,
  grid,
  playhead,
  playing,
  onEffects,
  onOpenEditor,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  /** The lane's place among the song's lanes (its default colour and plugin address). */
  index: number;
  barWidth: number;
  barCount: number;
  grid: SongGrid;
  playhead?: PlayheadStore;
  playing: boolean;
  onEffects: (index: number) => void;
  onOpenEditor: (laneId: string) => void;
}) {
  const { audio, apply } = lanes;
  const [renaming, setRenaming] = useState(false);
  const color = laneColor(index, lane.color);
  const update = (patch: Partial<AudioLane>) => apply((a) => updateLane(a, lane.id, patch));
  const toX = useCallback(
    (ms: number) => barAtTimelineMs(audio, grid, ms) * barWidth,
    [audio, grid, barWidth],
  );
  const toMs = useCallback(
    (x: number) => timelineMsAtBar(audio, grid, x / barWidth),
    [audio, grid, barWidth],
  );
  const label = lane.folder ? `folder ${lane.name}` : `lane ${lane.name}`;
  const children = lane.folder ? audio.lanes.filter((l) => l.parent === lane.id).length : 0;

  const drop = (drag: ClipDrag) => {
    if (drag.kind === "move")
      apply((a) => moveClip(a, drag.clipId, drag.startMs, drag.laneId ?? undefined));
    else apply((a) => trimClip(a, drag.clipId, drag.edge, drag.atMs));
  };
  const setCursor = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    lanes.setEditCursorMs(lanes.snapTo(toMs(x)));
    lanes.select([]);
  };
  const cursorX = toX(lanes.editCursorMs);
  // The row is as long as the score or its last clip, whichever ends later.
  const scoreWidth = barCount * barWidth;
  const clipsEnd = lane.clips.reduce((x, clip) => Math.max(x, toX(clipEndMs(clip))), 0);
  const width = Math.max(scoreWidth, Math.ceil(clipsEnd / barWidth) * barWidth);

  return (
    <li className="flex border-b" data-testid={`lane-row-${lane.id}`}>
      <div
        role="presentation"
        className={cn(
          "sticky left-0 z-10 flex w-[30rem] shrink-0 items-center border-r bg-card px-2 py-1",
          lane.parent && "pl-5",
        )}
        onDoubleClick={() => onOpenEditor(lane.id)}
      >
        <div className={cn(CONTROLS, "w-full")}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-5 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            {lane.folder ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-expanded={!lane.collapsed}
                aria-label={`${lane.collapsed ? "Open" : "Close"} the folder ${lane.name}`}
                onClick={() => update({ collapsed: !lane.collapsed })}
              >
                {lane.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </Button>
            ) : (
              <AudioLinesIcon className="size-4 shrink-0" aria-hidden="true" />
            )}
            {renaming ? (
              <input
                aria-label={`Name of the ${label}`}
                defaultValue={lane.name}
                ref={(el) => el?.focus()}
                maxLength={200}
                className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-sm"
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name && name !== lane.name) update({ name });
                  setRenaming(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() =>
                  lane.folder ? update({ collapsed: !lane.collapsed }) : onOpenEditor(lane.id)
                }
                aria-label={`Edit the ${label}`}
                title={lane.folder ? `${children} lanes` : "Open the lane editor"}
                className="min-w-0 truncate rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {lane.folder && <FolderIcon className="mr-1 inline size-3.5" aria-hidden="true" />}
                {lane.name}
              </button>
            )}
          </div>
          <div className="flex items-center">
            <Switch
              checked={lane.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
              aria-label={`${lane.name} on`}
            />
          </div>
          <div className="flex gap-0.5">
            <Toggle
              size="sm"
              variant="outline"
              pressed={lane.mute}
              onPressedChange={(mute) => update({ mute })}
              aria-label={`Mute the ${label}`}
              className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
            >
              M
            </Toggle>
            <Toggle
              size="sm"
              variant="outline"
              pressed={lane.solo}
              onPressedChange={(solo) => update({ solo })}
              aria-label={`Solo the ${label}`}
              className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
            >
              S
            </Toggle>
          </div>
          <div className="flex flex-col gap-0.5">
            <LabeledSlider
              label={`Volume, ${lane.name}`}
              valueText={describeVolume(lane.volume)}
              value={lane.volume}
              onValueChange={(volume) => update({ volume })}
            />
            {!lane.folder && (
              <LevelMeter
                label={`Level, ${lane.name}`}
                select={(m) => m.lanes?.find(([id]) => id === lane.id)?.[1] ?? 0}
              />
            )}
          </div>
          <PanControl
            label={`Pan, ${lane.name}`}
            value={lane.pan}
            onValueChange={(pan) => update({ pan })}
          />
          <div className="flex items-center justify-end gap-0.5">
            {!lane.folder && (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Effects of ${lane.name}`}
                  title={lane.effects.length ? `${lane.effects.length} effects` : "Effects"}
                  onClick={() => onEffects(index)}
                  data-tour="lane-effects"
                >
                  <SlidersHorizontalIcon />
                </Button>
              </>
            )}
            <LaneColorPopover
              laneName={lane.name}
              index={index}
              color={lane.color}
              onChange={(c) => update({ color: c })}
            />
            <LaneMenu
              lanes={lanes}
              lane={lane}
              index={index}
              onOpenEditor={onOpenEditor}
              onRename={() => setRenaming(true)}
            />
          </div>
        </div>
      </div>
      <LaneContextMenu lanes={lanes} lane={lane} toMs={toMs} onOpenEditor={onOpenEditor}>
        <div
          role="presentation"
          data-lane-id={lane.folder ? undefined : lane.id}
          data-px-per-bar={barWidth}
          className="relative h-[3.25rem] shrink-0"
          style={{ width }}
          onClick={setCursor}
          aria-hidden={lane.folder || undefined}
        >
          {width > scoreWidth && (
            <span
              aria-hidden="true"
              data-testid="past-score"
              title="Past the end of the score"
              className="pointer-events-none absolute inset-y-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_oklab,var(--muted-foreground)_14%,transparent)_6px_8px)]"
              style={{ left: scoreWidth, width: width - scoreWidth }}
            />
          )}
          {!lane.folder &&
            lane.clips.map((clip) => (
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
                compact
                onSelect={(additive) =>
                  lanes.select(additive ? [...new Set([...lanes.selection, clip.id])] : [clip.id])
                }
                onDrop={drop}
                onKey={(event) =>
                  handleClipKey(event, lanes, clip.id, lane.id, () => onOpenEditor(lane.id))
                }
                onOpen={() => onOpenEditor(lane.id)}
                onCursor={lanes.setEditCursorMs}
              />
            ))}
          <span
            aria-hidden="true"
            data-testid="edit-cursor"
            className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-primary"
            style={{ left: cursorX }}
          />
          {playhead && <Playhead store={playhead} barWidth={barWidth} playing={playing} />}
        </div>
      </LaneContextMenu>
    </li>
  );
}

/** More lane commands: rename, move up or down, into a folder, edit group, remove. */
function LaneMenu({
  lanes,
  lane,
  index,
  onOpenEditor,
  onRename,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  index: number;
  onOpenEditor: (laneId: string) => void;
  onRename: () => void;
}) {
  const { apply, audio } = lanes;
  const folders = audio.lanes.filter((l) => l.folder && l.id !== lane.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`More for ${lane.name}`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!lane.folder && (
          <DropdownMenuItem onSelect={() => onOpenEditor(lane.id)}>
            Open the lane editor
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === 0}
          onSelect={() => apply((a) => moveLane(a, lane.id, index - 1))}
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === audio.lanes.length - 1}
          onSelect={() => apply((a) => moveLane(a, lane.id, index + 1))}
        >
          Move down
        </DropdownMenuItem>
        {!lane.folder && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => apply((a) => makeFolder(a, "Folder", [lane.id]))}>
              Put in a new folder
            </DropdownMenuItem>
            {folders.map((f) => (
              <DropdownMenuItem
                key={f.id}
                onSelect={() => apply((a) => updateLane(a, lane.id, { parent: f.id }))}
              >
                Put in {f.name}
              </DropdownMenuItem>
            ))}
            {lane.parent && (
              <DropdownMenuItem
                onSelect={() => apply((a) => updateLane(a, lane.id, { parent: undefined }))}
              >
                Take out of the folder
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => apply((a) => updateLane(a, lane.id, { group: lane.group ? 0 : 1 }))}
            >
              {lane.group ? "Leave the edit group" : "Join the edit group"}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => apply((a) => removeLane(a, lane.id))}
        >
          Remove {lane.folder ? "folder" : "lane"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
