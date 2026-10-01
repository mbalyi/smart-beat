import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { AudioLinesIcon, FolderOpenIcon, Trash2Icon, WandIcon, XIcon } from "lucide-react";

import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FILTER_LABELS, formatMs } from "@/lib/audio/audio-track";
import { audioMsAt } from "@/lib/audio/engine-config";
import type { AudioTrackSettings, BackingFilter, BackingInfo, SyncPoint } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Longest canvas the browsers draw (px). */
const MAX_CANVAS = 30_000;
const WAVE_HEIGHT = 64;

/** Song ms at a (fractional) bar position, from the bar start times. */
function songMsAtBar(barTimes: readonly number[], bar: number) {
  const b = Math.max(0, Math.min(Math.floor(bar), barTimes.length - 2));
  const start = barTimes[b] ?? 0;
  const end = barTimes[b + 1] ?? start;
  return start + (bar - b) * (end - start);
}

function cssColor(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * The recording's waveform laid out on the score's bars: each bar shows the
 * part of the recording the sync points tie to it.
 */
export function AudioWaveform({
  info,
  sync,
  barTimes,
  barWidth,
  className,
}: {
  info: BackingInfo;
  sync: readonly SyncPoint[];
  /** Song ms where each bar starts, plus the song's end. */
  barTimes: readonly number[];
  barWidth: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bars = Math.max(0, barTimes.length - 1);
  const width = Math.min(MAX_CANVAS, Math.max(1, Math.round(bars * barWidth)));
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = width * scale;
    canvas.height = WAVE_HEIGHT * scale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);
    ctx.fillStyle = cssColor("--primary", "#4f46e5");
    const points = sync.flatMap((p) =>
      barTimes[p.bar] === undefined ? [] : [{ songMs: barTimes[p.bar]!, ms: p.ms }],
    );
    const perMs = info.peaksPerSecond / 1000;
    const mid = WAVE_HEIGHT / 2;
    let from = audioMsAt(points, songMsAtBar(barTimes, 0));
    for (let x = 0; x < width; x++) {
      const to = audioMsAt(points, songMsAtBar(barTimes, (x + 1) / barWidth));
      const a = Math.max(0, Math.floor(Math.min(from, to) * perMs));
      const b = Math.min(info.peaks.length, Math.ceil(Math.max(from, to) * perMs) + 1);
      let peak = 0;
      for (let i = a; i < b; i++) peak = Math.max(peak, info.peaks[i] ?? 0);
      const h = Math.max(peak > 0 ? 1 : 0, peak * (mid - 2));
      ctx.fillRect(x, mid - h, 1, h * 2);
      from = to;
    }
  }, [info, sync, barTimes, barWidth, width]);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ width, height: WAVE_HEIGHT }}
      className={cn("block", className)}
    />
  );
}

function SyncMarker({
  point,
  x,
  msPerPx,
  onMove,
  onRemove,
}: {
  point: SyncPoint;
  x: number;
  /** Recording ms per pixel of drag. */
  msPerPx: number;
  onMove: (ms: number) => void;
  onRemove: () => void;
}) {
  const drag = useRef<{ x: number; ms: number } | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 100 : 10;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") onMove(point.ms + step);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown")
      onMove(Math.max(0, point.ms - step));
    else if (event.key === "Delete" || event.key === "Backspace") onRemove();
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`Sync point at bar ${point.bar + 1}`}
      aria-valuemin={0}
      aria-valuenow={Math.round(point.ms)}
      aria-valuetext={`${formatMs(point.ms)} in the recording`}
      aria-keyshortcuts="ArrowLeft ArrowRight Delete"
      title={`Bar ${point.bar + 1} = ${formatMs(point.ms)}. Drag or use the arrow keys (Shift: bigger steps) to line the bar up with the recording; Delete removes it.`}
      data-testid="sync-point"
      onKeyDown={onKeyDown}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.currentTarget.focus();
        drag.current = { x: event.clientX, ms: point.ms };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start) onMove(Math.max(0, Math.round(start.ms + (event.clientX - start.x) * msPerPx)));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="absolute top-0 bottom-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize touch-none justify-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      style={{ left: x }}
    >
      <span className="h-full w-0.5 bg-amber-500" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="absolute top-0 size-2.5 rotate-45 border border-amber-700 bg-amber-400"
      />
    </div>
  );
}

/**
 * The audio track editor: the waveform on the score's bars, zoom, sync
 * points (double-click a bar line to add one, drag or use the arrow keys to
 * line it up, Delete removes it), transposition, filter and file options.
 */
export function AudioTrackPanel({
  audio,
  info,
  barTimes,
  barWidth,
  onBarWidthChange,
  onChange,
  onRemove,
  onLocate,
  onImportTempo,
  onClose,
  canEmbed,
}: {
  audio: AudioTrackSettings;
  /** Null while loading, or when the file is missing. */
  info: BackingInfo | null;
  barTimes: readonly number[];
  /** Zoom: pixels per bar. */
  barWidth: number;
  onBarWidthChange: (px: number) => void;
  onChange: (audio: AudioTrackSettings) => void;
  onRemove: () => void;
  /** Look for a missing (or another) file. */
  onLocate: () => void;
  onImportTempo: () => void;
  onClose: () => void;
  /** Whether the song can embed the recording (saved as .gp). */
  canEmbed: boolean;
}) {
  const ids = useId();
  const bars = Math.max(0, barTimes.length - 1);
  const width = Math.min(MAX_CANVAS, bars * barWidth);
  const points = audio.sync.flatMap((p) =>
    barTimes[p.bar] === undefined ? [] : [{ songMs: barTimes[p.bar]!, ms: p.ms }],
  );
  const setSync = (sync: SyncPoint[]) =>
    onChange({ ...audio, sync: [...sync].sort((a, b) => a.bar - b.bar) });

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const bar = Math.max(0, Math.min(bars - 1, Math.round((event.clientX - rect.left) / barWidth)));
    if (audio.sync.some((p) => p.bar === bar)) return;
    const ms = Math.max(0, Math.round(audioMsAt(points, barTimes[bar] ?? 0)));
    setSync([...audio.sync, { bar, ms }]);
  };

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex shrink-0 flex-col gap-2 border-t bg-card px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={`${ids}-title`} className="flex items-center gap-1.5 font-semibold">
          <AudioLinesIcon className="size-4" aria-hidden="true" />
          Audio track
        </h2>
        <span className="max-w-60 truncate text-muted-foreground" title={audio.path ?? audio.name}>
          {audio.name}
          {info && ` · ${formatMs(info.durationMs)}`}
        </span>
        <span className="flex items-center gap-1.5">
          <Switch
            checked={audio.enabled}
            onCheckedChange={(enabled) => onChange({ ...audio, enabled })}
            aria-label="Audio track on"
          />
          On
        </span>
        <div className="flex w-40 items-center gap-2">
          <span id={`${ids}-zoom`} className="text-xs text-muted-foreground">
            Zoom
          </span>
          <LabeledSlider
            label="Waveform zoom"
            valueText={`${barWidth} pixels per bar`}
            value={barWidth}
            min={20}
            max={160}
            step={4}
            onValueChange={onBarWidthChange}
          />
        </div>
        <span className="ml-auto flex gap-1">
          <Button variant="outline" size="sm" onClick={onImportTempo}>
            <WandIcon data-icon="inline-start" />
            Sync points from tempo changes
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={audio.sync.length === 0}
            onClick={() => setSync([])}
          >
            Clear sync points
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove the audio track"
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close the audio track editor"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor={`${ids}-semitones`}>Semitones</label>
          <Input
            id={`${ids}-semitones`}
            type="number"
            min={-24}
            max={24}
            value={audio.semitones}
            onChange={(e) => onChange({ ...audio, semitones: Number(e.target.value) || 0 })}
            className="h-8 w-20"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor={`${ids}-cents`}>Cents</label>
          <Input
            id={`${ids}-cents`}
            type="number"
            min={-100}
            max={100}
            step={5}
            value={audio.cents}
            onChange={(e) => onChange({ ...audio, cents: Number(e.target.value) || 0 })}
            className="h-8 w-20"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <span id={`${ids}-filter`}>Filter</span>
          <Select
            value={audio.filter}
            onValueChange={(filter) => onChange({ ...audio, filter: filter as BackingFilter })}
          >
            <SelectTrigger size="sm" aria-labelledby={`${ids}-filter`} className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FILTER_LABELS) as BackingFilter[]).map((f) => (
                <SelectItem key={f} value={f}>
                  {FILTER_LABELS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span
          className={cn("flex items-center gap-1.5 text-xs", !canEmbed && "opacity-60")}
          title={canEmbed ? undefined : "Save the song as a .gp file to embed the recording"}
        >
          <Switch
            checked={audio.embedded}
            disabled={!canEmbed}
            onCheckedChange={(embedded) => onChange({ ...audio, embedded })}
            aria-label="Embed the recording in the song file"
          />
          Embed in the song file
        </span>
        <p className="text-xs text-muted-foreground">
          Playback speed and the speed trainer stretch the recording without changing its pitch.
        </p>
      </div>

      {info ? (
        <div className="overflow-x-auto pb-1">
          <div
            aria-hidden="true"
            className="relative h-4 text-[10px] text-muted-foreground tabular-nums"
            style={{ width }}
          >
            {Array.from({ length: bars }, (_, b) =>
              b === 0 || (barWidth >= 40 ? true : (b + 1) % 4 === 0) ? (
                <span key={b} className="absolute" style={{ left: b * barWidth + 2 }}>
                  {b + 1}
                </span>
              ) : null,
            )}
          </div>
          {/* Double-clicking is a mouse shortcut for adding a sync point at the nearest bar line. */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className="relative rounded-sm bg-muted/50"
            style={{
              width,
              backgroundImage: `repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px ${barWidth}px)`,
            }}
            onDoubleClick={onDoubleClick}
            data-testid="audio-waveform"
          >
            <AudioWaveform info={info} sync={audio.sync} barTimes={barTimes} barWidth={barWidth} />
            {audio.sync.map((p) => {
              const span = (barTimes[p.bar + 1] ?? barTimes[p.bar] ?? 0) - (barTimes[p.bar] ?? 0);
              return (
                <SyncMarker
                  key={p.bar}
                  point={p}
                  x={p.bar * barWidth}
                  msPerPx={Math.max(1, span / barWidth)}
                  onMove={(ms) =>
                    setSync(audio.sync.map((q) => (q.bar === p.bar ? { ...q, ms } : q)))
                  }
                  onRemove={() => setSync(audio.sync.filter((q) => q.bar !== p.bar))}
                />
              );
            })}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Double-click a bar line to add a sync point, then drag it (or use the arrow keys) until
            the bar starts where it does in the recording.
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          The recording “{audio.name}” is not loaded.
          <Button variant="outline" size="sm" onClick={onLocate}>
            <FolderOpenIcon data-icon="inline-start" />
            Find the file…
          </Button>
        </p>
      )}
    </section>
  );
}
