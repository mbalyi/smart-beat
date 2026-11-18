import { useCallback, useEffect, useRef } from "react";

import { dropCopyOrSlip } from "@/components/audio-lanes/clip-copy-slip";
import { handleClipKey } from "@/components/audio-lanes/clip-keys";
import { ClipView, type ClipDrag } from "@/components/audio-lanes/clip-view";
import { EmptyLaneHint } from "@/components/audio-lanes/empty-lane-hint";
import { LaneContextMenu } from "@/components/audio-lanes/lane-context-menu";
import { LaneHeader } from "@/components/audio-lanes/lane-header";
import { LaneResizeHandle } from "@/components/audio-lanes/lane-resize-handle";
import { MarqueeBox } from "@/components/audio-lanes/selection-overlay";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { useMarquee } from "@/components/audio-lanes/use-marquee";
import type { BarBounds } from "@/lib/audio-lanes/bar-bounds";
import { moveClipGroup } from "@/lib/audio-lanes/clip-groups";
import { registerLaneResolver } from "@/lib/audio-lanes/drop-target";
import { trimClip } from "@/lib/audio-lanes/edits";
import { COMPACT_LANE_HEIGHT, laneHeight } from "@/lib/audio-lanes/lane-height";
import { clipEndMs } from "@/lib/audio-lanes/model";
import { bandSelectableLanes } from "@/lib/audio-lanes/band-rows";
import { clickSelection } from "@/lib/audio-lanes/selection";
import { laneColor } from "@/lib/score/track-colors";
import type { AudioClip, AudioLane } from "@/lib/tauri";

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

/** The strip above a lane's clips that holds its header, px: one row of 24 px buttons. */
const HEADER_STRIP_PX = 28;

/**
 * A lane's header in a slim strip above its clips: the studio's header in its one-row form (name,
 * mute, solo, add audio, effects; sends and auto bypass are in the editor). The header stays at
 * the left edge of the view while the score scrolls. It has a strip of its own, not the clips'
 * area, so it never covers a clip or its handles. The strip lets the pointer through.
 */
function BandHeader({
  lanes,
  lane,
  color,
  onEffects,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  color: string;
  onEffects?: (laneId: string) => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 border-b border-dashed"
      style={{ height: HEADER_STRIP_PX }}
    >
      <div className="sticky left-1 z-30 w-fit">
        <LaneHeader
          lanes={lanes}
          lane={lane}
          compact
          quickActions
          onEffects={onEffects && (() => onEffects(lane.id))}
          className="pointer-events-auto max-w-56 items-center gap-2 px-2 pl-3"
          style={{ height: HEADER_STRIP_PX - 1, boxShadow: `inset 3px 0 0 ${color}` }}
        />
      </div>
    </div>
  );
}

/** A folder: a thin header row with the studio's folder header, which opens and closes it. */
export function BandFolder({ lanes, lane }: { lanes: AudioLanesController; lane: AudioLane }) {
  return (
    <div
      role="group"
      aria-label={`Folder ${lane.name}`}
      data-testid={`band-folder-${lane.id}`}
      className="relative h-9 border-b bg-muted/40"
    >
      <div className="pointer-events-none sticky left-1 z-30 w-fit">
        <LaneHeader
          lanes={lanes}
          lane={lane}
          compact
          className="pointer-events-auto h-9 items-center gap-2 px-2"
        />
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
  onEffects,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  /** The lane's place among the song's lanes (its default colour). */
  index: number;
  bounds: BarBounds;
  view: BandView | null;
  onOpenEditor?: (laneId: string) => void;
  /** Opens the lane's effects (the pedalboard). */
  onEffects?: (laneId: string) => void;
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
      style={{ height: height + HEADER_STRIP_PX }}
    >
      <BandHeader lanes={lanes} lane={lane} color={color} onEffects={onEffects} />
      <LaneContextMenu lanes={lanes} lane={lane} toMs={toMs} onOpenEditor={onOpenEditor}>
        <div
          ref={laneRef}
          role="presentation"
          data-lane-id={lane.id}
          className="absolute inset-x-0 bottom-0"
          style={{ top: HEADER_STRIP_PX }}
          {...marquee.handlers}
        >
          {range && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 border-x border-primary/40 bg-primary/15"
              style={{ left: toX(range.startMs), width: toX(range.endMs) - toX(range.startMs) }}
            />
          )}
          {lane.clips.length === 0 && <EmptyLaneHint />}
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
      <LaneResizeHandle lanes={lanes} lane={lane} />
    </div>
  );
}
