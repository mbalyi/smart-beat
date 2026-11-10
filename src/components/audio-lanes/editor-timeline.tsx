import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";

import { ClipView, type ClipDrag } from "@/components/audio-lanes/clip-view";
import { handleClipKey } from "@/components/audio-lanes/clip-keys";
import { LaneContextMenu } from "@/components/audio-lanes/lane-context-menu";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { moveClip, trimClip } from "@/lib/audio-lanes/edits";
import { clipEndMs } from "@/lib/audio-lanes/model";
import {
  moveSyncPoint,
  segmentBpms,
  setZone,
  shiftPadding,
  timelineMsAt,
  timelineMsAtBar,
  toggleSyncPoint,
  type SongGrid,
} from "@/lib/audio-lanes/sync";
import { usePlayheadBar, type PlayheadStore } from "@/lib/score/playhead";
import type { AudioLane } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Seconds a time-ruler label stands for at a zoom (pixels per second). */
function rulerStep(pxPerSecond: number): number {
  return [0.5, 1, 2, 5, 10, 30, 60].find((s) => s * pxPerSecond >= 48) ?? 60;
}

/**
 * The editor's timeline for one lane, laid out in audio time: the bar numbers, the play zone
 * brackets with a BPM label per sync segment and the sync triangles, the clips over a beat grid
 * (solid bar lines, dashed beats) and the time ruler. Double-click a beat to add or remove a sync
 * point; drag a triangle to move it; Cmd-drag the waveform to slide the audio against the grid;
 * drag on the time ruler to select bars.
 */
export function EditorTimeline({
  lanes,
  lane,
  color,
  grid,
  pxPerSecond,
  scoreBpmAt,
  playhead,
  selectedBars,
  onSelectBars,
  onSeekBar,
  follow = false,
  scroller,
  onAutoScroll,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  color: string;
  grid: SongGrid;
  pxPerSecond: number;
  scoreBpmAt: (bar: number) => number;
  playhead?: PlayheadStore;
  /** The bars selected in the score (mirrored here). */
  selectedBars: { start: number; end: number } | null;
  onSelectBars: (start: number, end: number) => void;
  /** Plays from a bar; with `loop`, loops the selected bars. */
  onSeekBar: (bar: number, loop: boolean) => void;
  /** Scrolls `scroller` to keep the position line in view (while playing). */
  follow?: boolean;
  scroller?: RefObject<HTMLElement | null>;
  /** Called just before following scrolls, so the scroll is not taken for the user's. */
  onAutoScroll?: () => void;
}) {
  const { audio, apply } = lanes;
  const toX = (ms: number) => (ms / 1000) * pxPerSecond;
  const toMs = (x: number) => (x / pxPerSecond) * 1000;
  const bars = grid.barTimes.length;
  const barX = useMemo(
    () => Array.from({ length: bars + 1 }, (_, b) => toX(timelineMsAtBar(audio, grid, b))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audio, grid, bars, pxPerSecond],
  );
  const end = Math.max(barX[bars] ?? 0, ...lane.clips.map((c) => toX(clipEndMs(c)))) + 80;
  const bpms = useMemo(() => segmentBpms(audio, grid, scoreBpmAt), [audio, grid, scoreBpmAt]);
  const active = new Set(audio.sync.map((p) => `${p.bar}:${p.beat ?? 0}`));
  const zoneStart = audio.zone.start;
  const zoneEnd = audio.zone.end ?? bars;
  const pad = useRef<{ x: number; done: number } | null>(null);
  const [rulerDrag, setRulerDrag] = useState<{ from: number; to: number } | null>(null);
  const barAtX = (x: number) => {
    let b = 0;
    while (b + 1 < bars && (barX[b + 1] ?? Infinity) <= x) b++;
    return b;
  };

  const drop = (drag: ClipDrag) => {
    if (drag.kind === "move") apply((a) => moveClip(a, drag.clipId, drag.startMs));
    else apply((a) => trimClip(a, drag.clipId, drag.edge, drag.atMs));
  };
  const dragPoint = (bar: number, beat: number) => (event: PointerEvent<HTMLButtonElement>) => {
    const startX = event.clientX;
    const startMs = timelineMsAt(audio, grid, bar, beat);
    lanes.beginGesture();
    const move = (e: globalThis.PointerEvent) =>
      lanes.applyQuiet((a) => moveSyncPoint(a, bar, beat, startMs + toMs(e.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const dragBracket = (edge: "start" | "end") => (event: PointerEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.parentElement!.getBoundingClientRect();
    lanes.beginGesture();
    const move = (e: globalThis.PointerEvent) =>
      lanes.applyQuiet((a) =>
        setZone(a, edge, barAtX(e.clientX - box.left) + (edge === "end" ? 1 : 0)),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="relative min-w-full select-none" style={{ width: end }}>
      {/* Bar numbers: click plays from the bar, Shift loops the selection. */}
      <div className="relative h-6 border-b text-[11px] font-semibold">
        {barX.slice(0, bars).map((x, b) => (
          <button
            key={b}
            type="button"
            className="absolute top-0 h-6 min-w-6 rounded px-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            style={{ left: x }}
            aria-label={`Play from bar ${b + 1}`}
            title="Play from here (Shift: loop the selection)"
            onClick={(e) => onSeekBar(b, e.shiftKey)}
          >
            {b + 1}
          </button>
        ))}
      </div>
      {/* Play zone, BPM labels and sync points. */}
      <div className="relative h-14 border-b text-[11px]" data-testid="sync-row">
        <span
          className="absolute inset-y-0 bg-primary/10"
          style={{ left: barX[zoneStart], width: (barX[zoneEnd] ?? end) - (barX[zoneStart] ?? 0) }}
        />
        <button
          type="button"
          aria-label={`Play zone start, bar ${zoneStart + 1}`}
          className="absolute top-1 z-10 h-6 w-6 cursor-ew-resize text-center font-bold text-emerald-600 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-emerald-400"
          style={{ left: barX[zoneStart] ?? 0 }}
          onPointerDown={dragBracket("start")}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight")
              apply((a) => setZone(a, "start", zoneStart + (e.key === "ArrowLeft" ? -1 : 1)));
          }}
        >
          [
        </button>
        <button
          type="button"
          aria-label={`Play zone end, bar ${zoneEnd}`}
          className="absolute top-1 z-10 h-6 w-6 cursor-ew-resize text-center font-bold text-red-600 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-red-400"
          style={{ left: (barX[zoneEnd] ?? end) - 24 }}
          onPointerDown={dragBracket("end")}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight")
              apply((a) => setZone(a, "end", zoneEnd + (e.key === "ArrowLeft" ? -1 : 1)));
          }}
        >
          ]
        </button>
        {bpms.map((s) => (
          <span
            key={`${s.bar}:${s.beat}`}
            className="absolute top-2 text-foreground"
            style={{ left: toX(timelineMsAt(audio, grid, s.bar, s.beat)) + 10 }}
          >
            {s.bpm.toFixed(1)} bpm
          </span>
        ))}
        {barX.slice(zoneStart, zoneEnd + 1).map((x, i) => {
          const bar = zoneStart + i;
          const on = active.has(`${bar}:0`);
          return (
            <button
              key={bar}
              type="button"
              aria-pressed={on}
              aria-label={`Sync point at bar ${bar + 1}`}
              title={
                on ? "Drag to move; double-click to remove" : "Double-click to add a sync point"
              }
              className="absolute bottom-0 z-10 flex size-6 -translate-x-1/2 items-end justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{ left: x }}
              onDoubleClick={() => apply((a) => toggleSyncPoint(a, grid, bar))}
              onPointerDown={on ? dragPoint(bar, 0) : undefined}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply((a) => toggleSyncPoint(a, grid, bar));
                if (on && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                  const step = e.shiftKey ? 50 : 5;
                  apply((a) =>
                    moveSyncPoint(
                      a,
                      bar,
                      0,
                      timelineMsAt(a, grid, bar) + (e.key === "ArrowLeft" ? -step : step),
                    ),
                  );
                }
                if (on && e.key === "Delete") apply((a) => toggleSyncPoint(a, grid, bar));
              }}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-3 [clip-path:polygon(0_0,100%_0,50%_100%)]",
                  on ? "bg-foreground" : "bg-muted-foreground/60",
                )}
              />
            </button>
          );
        })}
        {audio.sync
          .filter((p) => (p.beat ?? 0) > 0)
          .map((p) => (
            <button
              key={`${p.bar}:${p.beat}`}
              type="button"
              aria-label={`Sync point at bar ${p.bar + 1}, beat ${(p.beat ?? 0) + 1}`}
              className="absolute bottom-0 z-10 flex size-6 -translate-x-1/2 items-end justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{ left: toX(p.ms) }}
              onDoubleClick={() => apply((a) => toggleSyncPoint(a, grid, p.bar, p.beat))}
              onPointerDown={dragPoint(p.bar, p.beat ?? 0)}
            >
              <span
                aria-hidden="true"
                className="size-3 bg-foreground [clip-path:polygon(0_0,100%_0,50%_100%)]"
              />
            </button>
          ))}
      </div>
      {/* Clips over the beat grid. Cmd-drag on empty space slides the audio (padding). */}
      <LaneContextMenu lanes={lanes} lane={lane} toMs={toMs}>
        <div
          role="presentation"
          className="relative h-28"
          data-lane-id={lane.id}
          data-ms-per-px={1000 / pxPerSecond}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.metaKey || e.ctrlKey) {
              pad.current = { x: e.clientX, done: 0 };
              lanes.beginGesture();
              e.currentTarget.setPointerCapture?.(e.pointerId);
            } else {
              const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
              lanes.setEditCursorMs(lanes.snapTo(toMs(x)));
              lanes.select([]);
            }
          }}
          onPointerMove={(e) => {
            const p = pad.current;
            if (!p) return;
            const delta = -toMs(e.clientX - p.x) - p.done;
            p.done += delta;
            lanes.applyQuiet((a) => shiftPadding(a, grid, delta));
          }}
          onPointerUp={() => (pad.current = null)}
          onDoubleClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
            const bar = barAtX(x);
            const beats = grid.beats[bar] ?? 4;
            const within =
              ((x - (barX[bar] ?? 0)) / Math.max(1, (barX[bar + 1] ?? x + 1) - (barX[bar] ?? 0))) *
              beats;
            apply((a) => toggleSyncPoint(a, grid, bar, Math.min(beats - 1, Math.round(within))));
          }}
        >
          {barX.slice(0, bars).map((x, b) => {
            const width = (barX[b + 1] ?? x) - x;
            const beats = grid.beats[b] ?? 4;
            return (
              <span
                key={b}
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0"
                style={{ left: x, width }}
              >
                <span className="absolute inset-y-0 left-0 w-px bg-red-500/70" />
                {Array.from({ length: beats - 1 }, (_, i) => (
                  <span
                    key={i}
                    className="absolute inset-y-0 border-l border-dashed border-amber-500/40"
                    style={{ left: (width * (i + 1)) / beats }}
                  />
                ))}
              </span>
            );
          })}
          {selectedBars && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 bg-primary/20"
              style={{
                left: barX[selectedBars.start],
                width: (barX[selectedBars.end + 1] ?? end) - (barX[selectedBars.start] ?? 0),
              }}
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
              onDrop={drop}
              onKey={(event) => handleClipKey(event, lanes, clip.id, lane.id, () => undefined)}
              onOpen={() => undefined}
              onCursor={lanes.setEditCursorMs}
            />
          ))}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-primary"
            style={{ left: toX(lanes.editCursorMs) }}
          />
        </div>
      </LaneContextMenu>
      {/* Time ruler: drag to select bars. */}
      <div
        className="relative h-5 border-t text-[10px] text-muted-foreground"
        data-testid="time-ruler"
        onPointerDown={(e) => {
          const left = e.currentTarget.getBoundingClientRect().left;
          const from = barAtX(e.clientX - left);
          setRulerDrag({ from, to: from });
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!rulerDrag) return;
          setRulerDrag({
            ...rulerDrag,
            to: barAtX(e.clientX - e.currentTarget.getBoundingClientRect().left),
          });
        }}
        onPointerUp={() => {
          if (rulerDrag)
            onSelectBars(
              Math.min(rulerDrag.from, rulerDrag.to),
              Math.max(rulerDrag.from, rulerDrag.to),
            );
          setRulerDrag(null);
        }}
      >
        {Array.from({ length: Math.ceil(end / pxPerSecond / rulerStep(pxPerSecond)) }, (_, i) => {
          const seconds = i * rulerStep(pxPerSecond);
          return (
            <span
              key={i}
              className="absolute top-0 border-l pl-0.5"
              style={{ left: seconds * pxPerSecond }}
            >
              {Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, "0")}
            </span>
          );
        })}
      </div>
      {playhead && (
        <EditorPlayhead
          store={playhead}
          toX={(bar) => toX(timelineMsAtBar(audio, grid, bar))}
          follow={follow}
          scroller={scroller}
          onAutoScroll={onAutoScroll}
        />
      )}
    </div>
  );
}

/**
 * Where playback is: a line across the whole editor with a handle on the bar ruler. It shows
 * while stopped too (that is where Play starts and where Split and Paste act).
 */
function EditorPlayhead({
  store,
  toX,
  follow,
  scroller,
  onAutoScroll,
}: {
  store: PlayheadStore;
  toX: (bar: number) => number;
  follow: boolean;
  scroller?: RefObject<HTMLElement | null>;
  onAutoScroll?: () => void;
}) {
  const x = toX(usePlayheadBar(store));
  useEffect(() => {
    const el = scroller?.current;
    if (!follow || !el) return;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) {
      onAutoScroll?.();
      el.scrollTo?.({ left: Math.max(0, x - el.clientWidth / 4) });
    }
  }, [follow, onAutoScroll, scroller, x]);
  return (
    <span
      aria-hidden="true"
      data-testid="position-line"
      className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_var(--background)]"
      style={{ left: x }}
    >
      <span className="absolute -top-px left-1/2 size-3 -translate-x-1/2 bg-primary [clip-path:polygon(0_0,100%_0,50%_100%)]" />
    </span>
  );
}
