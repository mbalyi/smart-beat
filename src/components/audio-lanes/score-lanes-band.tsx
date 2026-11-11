import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { BandFolder, BandLane, type BandView } from "@/components/audio-lanes/band-lane";
import { SelectionStatus } from "@/components/audio-lanes/selection-overlay";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { createBarBounds, type BarBounds, type BarSpan } from "@/lib/audio-lanes/bar-bounds";
import { lanesEndMs } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { usePlayheadBar, type PlayheadStore } from "@/lib/score/playhead";

/** How far beyond the visible part (px) lanes are still drawn, so a scroll shows no gap. */
const DRAW_MARGIN_PX = 600;
/** The visible range moves in steps of this many pixels, so a scroll does not draw every frame. */
const VIEW_STEP_PX = 256;
/** Room after the last clip or bar. */
const TAIL_PX = 80;

/** The part of the band the scroller shows now (none while its size is not known). */
function useBandView(
  band: RefObject<HTMLDivElement | null>,
  scroller: HTMLElement | null,
): BandView | null {
  const [view, setView] = useState<BandView | null>(null);
  useEffect(() => {
    const element = band.current;
    if (!element || !scroller) return;
    const measure = () => {
      if (scroller.clientWidth === 0) return setView(null);
      // The left edge of what the scroller shows, in the band's own pixels.
      const left = scroller.getBoundingClientRect().left - element.getBoundingClientRect().left;
      const from = Math.floor((left - DRAW_MARGIN_PX) / VIEW_STEP_PX) * VIEW_STEP_PX;
      const to =
        Math.ceil((left + scroller.clientWidth + DRAW_MARGIN_PX) / VIEW_STEP_PX) * VIEW_STEP_PX;
      setView((previous) =>
        previous?.from === from && previous.to === to ? previous : { from, to },
      );
    };
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", later, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    resize?.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", later);
      resize?.disconnect();
    };
  }, [band, scroller]);
  return view;
}

/** Where playback is (a line through every lane) and where the edit cursor is (dashed). */
function BandLines({
  playhead,
  bounds,
  editCursorMs,
}: {
  playhead?: PlayheadStore;
  bounds: BarBounds;
  editCursorMs: number;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        data-testid="band-edit-cursor"
        className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-primary"
        style={{ left: bounds.msToX(editCursorMs) }}
      />
      {playhead && <BandPlayhead store={playhead} bounds={bounds} />}
    </>
  );
}

function BandPlayhead({ store, bounds }: { store: PlayheadStore; bounds: BarBounds }) {
  const bar = usePlayheadBar(store);
  return (
    <span
      aria-hidden="true"
      data-testid="band-position-line"
      className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_var(--background)]"
      style={{ left: bounds.barToX(bar) }}
    />
  );
}

/**
 * The audio lanes under the tabs in the continuous view: one row per lane directly under the last
 * stacked track, on the same bars (each clip is placed through the bars' measured x ranges, so it
 * lines up with the notation above it). Bar lines and the position line run through the rows, and
 * everything is edited in place through the shared `lanes` controller. The rows sit in the flow of
 * the score's paper, so the score's scroll area grows to make room and nothing covers a note.
 */
export function ScoreLanesBand({
  lanes,
  grid,
  spans,
  playhead,
  scroller,
  onOpenEditor,
}: {
  lanes: AudioLanesController;
  grid: SongGrid;
  /** Where the score draws each bar (px from the notation's left edge). */
  spans: readonly BarSpan[];
  playhead?: PlayheadStore;
  /** The box the score scrolls in, to draw only the lanes in view. */
  scroller: HTMLElement | null;
  onOpenEditor?: (laneId: string) => void;
}) {
  const { audio } = lanes;
  const bandRef = useRef<HTMLDivElement>(null);
  const view = useBandView(bandRef, scroller);
  const bounds = useMemo(() => createBarBounds(audio, grid, spans), [audio, grid, spans]);
  if (!bounds) return null;

  const width = Math.max(bounds.end, bounds.msToX(lanesEndMs(audio))) + TAIL_PX;
  const shown = audio.lanes.flatMap((lane, index) => {
    const folder = lane.parent ? audio.lanes.find((l) => l.id === lane.parent) : undefined;
    return folder?.collapsed ? [] : [{ lane, index }];
  });
  const bars = spans.flatMap((span, bar) =>
    !view || (span.x >= view.from && span.x <= view.to) ? [{ bar, x: span.x }] : [],
  );

  return (
    <div
      ref={bandRef}
      role="region"
      aria-label="Audio lanes under the score"
      data-lane-band
      data-testid="score-lanes-band"
      data-tour="lanes-band"
      className="relative border-t bg-muted/25 text-foreground"
      style={{ width }}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {width > bounds.end && (
          <span
            data-testid="band-past-score"
            title="Past the end of the score"
            className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,transparent_0_6px,color-mix(in_oklab,var(--muted-foreground)_14%,transparent)_6px_8px)]"
            style={{ left: bounds.end, width: width - bounds.end }}
          />
        )}
        {bars.map(({ bar, x }) => (
          <span
            key={bar}
            data-testid={`band-bar-${bar}`}
            className="absolute inset-y-0 w-px bg-foreground/20"
            style={{ left: x }}
          />
        ))}
      </div>
      {shown.map(({ lane, index }) =>
        lane.folder ? (
          <BandFolder key={lane.id} lanes={lanes} lane={lane} />
        ) : (
          <BandLane
            key={lane.id}
            lanes={lanes}
            lane={lane}
            index={index}
            bounds={bounds}
            view={view}
            onOpenEditor={onOpenEditor}
          />
        ),
      )}
      <BandLines playhead={playhead} bounds={bounds} editCursorMs={lanes.editCursorMs} />
      <SelectionStatus count={lanes.selection.length} />
    </div>
  );
}
