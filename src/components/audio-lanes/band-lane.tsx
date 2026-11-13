import { ChevronDownIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { dropCopyOrSlip } from "@/components/audio-lanes/clip-copy-slip";
import { handleClipKey } from "@/components/audio-lanes/clip-keys";
import { ClipView, type ClipDrag } from "@/components/audio-lanes/clip-view";
import { LaneContextMenu } from "@/components/audio-lanes/lane-context-menu";
import { MarqueeBox } from "@/components/audio-lanes/selection-overlay";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { useMarquee } from "@/components/audio-lanes/use-marquee";
import { Button } from "@/components/ui/button";
import type { BarBounds } from "@/lib/audio-lanes/bar-bounds";
import { moveClipGroup } from "@/lib/audio-lanes/clip-groups";
import { registerLaneResolver } from "@/lib/audio-lanes/drop-target";
import { trimClip, updateLane } from "@/lib/audio-lanes/edits";
import { COMPACT_LANE_HEIGHT, laneHeight } from "@/lib/audio-lanes/lane-height";
import { clipEndMs } from "@/lib/audio-lanes/model";
import { bandSelectableLanes } from "@/lib/audio-lanes/band-rows";
import { clickSelection } from "@/lib/audio-lanes/selection";
import { laneColor } from "@/lib/score/track-colors";
import type { AudioClip, AudioLane } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The part of the band's width on screen (px from the band's left edge); none: all of it. */
export interface BandView {
  from: number;
  to: number;
}

/** Where a lane's clips are not worth drawing: wholly off screen, and not selected. */
function isOffScreen(clip: AudioClip, selected: boolean, bounds: BarBounds, view: BandView | null) {
  if (!view || selected) return false;
  return bounds.msToX(clipEndMs(clip)) < view.from || bounds.msToX(clip.startMs) > view.to;
}

/** A folder: a thin header row, which opens and closes it. */
export function BandFolder({ lanes, lane }: { lanes: AudioLanesController; lane: AudioLane }) {
  return (
    <div
      role="group"
      aria-label={`Folder ${lane.name}`}
      data-testid={`band-folder-${lane.id}`}
      className="relative h-6 border-b bg-muted/50"
    >
      <div className="sticky left-1 z-30 flex h-full w-fit items-center gap-1 px-1 text-xs font-medium">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-expanded={!lane.collapsed}
          aria-label={`${lane.collapsed ? "Open" : "Close"} the folder ${lane.name} under the score`}
          onClick={() => lanes.apply((a) => updateLane(a, lane.id, { collapsed: !lane.collapsed }))}
        >
          {lane.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </Button>
        <FolderIcon className="size-3.5" aria-hidden="true" />
        <span className="truncate">{lane.name}</span>
      </div>
    </div>
  );
}

/**
 * The name of a lane at the left of its row, like the track rows: its colour strip, its name and
 * whether it is muted or soloed. It stays at the left edge of the view while the score scrolls, and
 * lets the pointer through to the clips under it.
 */
function LaneChip({ lane, color }: { lane: AudioLane; color: string }) {
  return (
    <div className="pointer-events-none sticky top-0 left-1 z-30 h-0 w-0">
      <div
        className={cn(
          "absolute top-1 left-0 flex max-w-60 items-center gap-1.5 rounded-md border bg-card/90 px-1.5 py-0.5 text-xs shadow-sm backdrop-blur-sm",
          lane.parent && "ml-3",
        )}
        data-testid={`band-lane-name-${lane.id}`}
      >
        <span
          aria-hidden="true"
          className="h-4 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="truncate font-medium">{lane.name}</span>
        <span
          aria-label={lane.mute ? "Muted" : "Not muted"}
          data-on={lane.mute || undefined}
          className="rounded px-1 text-[10px] leading-4 font-semibold text-muted-foreground data-[on]:bg-amber-500 data-[on]:text-black"
        >
          M
        </span>
        <span
          aria-label={lane.solo ? "Soloed" : "Not soloed"}
          data-on={lane.solo || undefined}
          className="rounded px-1 text-[10px] leading-4 font-semibold text-muted-foreground data-[on]:bg-sky-500 data-[on]:text-black"
        >
          S
        </span>
      </div>
    </div>
  );
}

/**
 * One audio lane under the tabs: its clips on the score's bars (a rounded rectangle in the lane
 * colour with the waveform in it), edited in place like in the track list and the studio. A drag
 * on empty space frames clips and a click puts the edit cursor (and playback) there.
 */
export function BandLane({
  lanes,
  lane,
  index,
  bounds,
  view,
  onOpenEditor,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  /** The lane's place among the song's lanes (its default colour). */
  index: number;
  bounds: BarBounds;
  view: BandView | null;
  onOpenEditor?: (laneId: string) => void;
}) {
  const { audio, apply } = lanes;
  const color = laneColor(index, lane.color);
  const height = laneHeight(lane);
  const compact = height < COMPACT_LANE_HEIGHT;
  const { msToX: toX, xToMs: toMs } = bounds;

  // A file dropped on the lane reads its pixels through the bars, not at a fixed rate.
  const toMsRef = useRef(toMs);
  useEffect(() => {
    toMsRef.current = toMs;
  });
  const laneRef = useCallback((element: HTMLElement | null) => {
    if (element) registerLaneResolver(element, (x) => toMsRef.current(x));
  }, []);

  const marquee = useMarquee({
    selection: lanes.selection,
    select: lanes.select,
    onTap: (e) => {
      lanes.setEditCursorMs(
        lanes.snapTo(toMs(e.clientX - e.currentTarget.getBoundingClientRect().left)),
      );
      lanes.select([]);
    },
    scope: (el) => el.closest("[data-lane-band]"),
  });
  const drop = (drag: ClipDrag) => {
    if (dropCopyOrSlip(lanes, drag)) return;
    if (drag.kind === "move")
      apply((a) => moveClipGroup(a, drag.clipId, drag.startMs, drag.laneId ?? undefined));
    else apply((a) => trimClip(a, drag.clipId, drag.edge, drag.atMs));
  };
  const range = lanes.timeRange;

  return (
    <div
      role="group"
      aria-label={`Audio lane ${lane.name} under the score`}
      data-testid={`band-lane-${lane.id}`}
      className="relative border-b"
      style={{ height }}
    >
      <LaneChip lane={lane} color={color} />
      <LaneContextMenu lanes={lanes} lane={lane} toMs={toMs} onOpenEditor={onOpenEditor}>
        <div
          ref={laneRef}
          role="presentation"
          data-lane-id={lane.id}
          className="absolute inset-0"
          {...marquee.handlers}
        >
          {range && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 border-x border-primary/40 bg-primary/15"
              style={{ left: toX(range.startMs), width: toX(range.endMs) - toX(range.startMs) }}
            />
          )}
          {lane.clips.map((clip) => {
            const selected = lanes.selection.includes(clip.id);
            if (isOffScreen(clip, selected, bounds, view)) return null;
            return (
              <ClipView
                key={clip.id}
                clip={clip}
                laneName={lane.name}
                color={color}
                info={lanes.infos.get(clip.takes[clip.take]?.sourceId ?? "")}
                missing={clip.takes.some((t) => lanes.missing.has(t.sourceId))}
                selected={selected}
                toX={toX}
                toMs={toMs}
                snap={lanes.snapTo}
                compact={compact}
                onSelect={(mode, alone) =>
                  lanes.select(
                    clickSelection(lanes.selection, clip.id, mode, bandSelectableLanes(audio)),
                    alone,
                  )
                }
                onDrop={drop}
                onKey={(event) =>
                  handleClipKey(event, lanes, clip.id, lane.id, () => onOpenEditor?.(lane.id))
                }
                onOpen={() => onOpenEditor?.(lane.id)}
                onCursor={lanes.setEditCursorMs}
                edits={lanes}
              />
            );
          })}
          <MarqueeBox box={marquee.box} />
        </div>
      </LaneContextMenu>
    </div>
  );
}
