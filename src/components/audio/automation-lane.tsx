import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeAutomationValue, LANE_LABELS } from "@/lib/audio/automation";
import type { AutomationLaneKind, AutomationPoint, TrackAutomation } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const LANE_HEIGHT = 44;
/** Positions snap to quarter bars. */
const SNAP = 4;

const RANGE: Record<AutomationLaneKind, [number, number]> = {
  volume: [0, 1],
  pan: [-1, 1],
  mute: [0, 1],
};

const snapBar = (bar: number) => Math.max(0, Math.round(bar * SNAP) / SNAP);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The lane kind picker shown next to a lane. */
export function LaneKindSelect({
  name,
  kind,
  onChange,
}: {
  name: string;
  kind: AutomationLaneKind;
  onChange: (kind: AutomationLaneKind) => void;
}) {
  return (
    <Select value={kind} onValueChange={(v) => onChange(v as AutomationLaneKind)}>
      <SelectTrigger size="sm" className="h-7 w-24" aria-label={`Automation lane, ${name}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(LANE_LABELS) as AutomationLaneKind[]).map((k) => (
          <SelectItem key={k} value={k}>
            {LANE_LABELS[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * An automation lane under a track's bar grid: click to add a point (snapped
 * to quarter bars), drag points, Delete removes the focused one; arrow keys
 * change its value (↑/↓) and position (←/→).
 */
export function AutomationLane({
  name,
  kind,
  automation,
  barCount,
  barWidth,
  onChange,
}: {
  name: string;
  kind: AutomationLaneKind;
  automation: TrackAutomation;
  barCount: number;
  /** Pixels per bar (including the gap), to line up with the bar grid. */
  barWidth: number;
  onChange: (automation: TrackAutomation) => void;
}) {
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const points = automation[kind];
  const [min, max] = RANGE[kind];
  const width = Math.max(1, barCount * barWidth);
  const pad = 5;
  const y = (value: number) => pad + (1 - (value - min) / (max - min)) * (LANE_HEIGHT - 2 * pad);
  const x = (bar: number) => bar * barWidth;

  const setPoints = (next: AutomationPoint[]) =>
    onChange({ ...automation, enabled: true, [kind]: [...next].sort((a, b) => a.bar - b.bar) });

  const toPoint = (clientX: number, clientY: number): AutomationPoint => {
    const rect = svgRef.current!.getBoundingClientRect();
    const bar = clamp(snapBar((clientX - rect.left) / barWidth), 0, barCount);
    const ratio = 1 - clamp((clientY - rect.top - pad) / (LANE_HEIGHT - 2 * pad), 0, 1);
    const raw = min + ratio * (max - min);
    const value = kind === "mute" ? (raw >= 0.5 ? 1 : 0) : Math.round(raw * 100) / 100;
    return { bar, value };
  };

  const onBackgroundDown = (event: PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    const point = toPoint(event.clientX, event.clientY);
    const others = points.filter((p) => p.bar !== point.bar);
    setPoints([...others, point]);
  };

  const onPointDown = (event: PointerEvent<SVGCircleElement>, index: number) => {
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    drag.current = { index, moved: false };
    setFocused(index);
  };
  const onPointMove = (event: PointerEvent<SVGCircleElement>) => {
    const current = drag.current;
    if (!current) return;
    current.moved = true;
    const next = toPoint(event.clientX, event.clientY);
    setPoints(points.map((p, i) => (i === current.index ? next : p)));
  };
  const onPointUp = () => {
    drag.current = null;
  };

  const onPointKey = (event: KeyboardEvent, index: number) => {
    const point = points[index];
    if (!point) return;
    const step = kind === "mute" ? 1 : event.shiftKey ? 0.1 : 0.05;
    let next: AutomationPoint | null = null;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setPoints(points.filter((_, i) => i !== index));
      setFocused(null);
      return;
    }
    if (event.key === "ArrowUp") next = { ...point, value: clamp(point.value + step, min, max) };
    if (event.key === "ArrowDown") next = { ...point, value: clamp(point.value - step, min, max) };
    if (event.key === "ArrowLeft") next = { ...point, bar: Math.max(0, point.bar - 1 / SNAP) };
    if (event.key === "ArrowRight")
      next = { ...point, bar: Math.min(barCount, point.bar + 1 / SNAP) };
    if (!next) return;
    event.preventDefault();
    setPoints(points.map((p, i) => (i === index ? next : p)));
  };

  // The line: flat before the first point and after the last; mute is a step.
  const path = (() => {
    if (points.length === 0) return "";
    const coords: [number, number][] = [[0, y(points[0]!.value)]];
    for (const [i, p] of points.entries()) {
      if (kind === "mute" && i > 0) coords.push([x(p.bar), y(points[i - 1]!.value)]);
      coords.push([x(p.bar), y(p.value)]);
    }
    coords.push([width, y(points[points.length - 1]!.value)]);
    return coords.map(([a, b], i) => `${i === 0 ? "M" : "L"}${a},${b}`).join(" ");
  })();

  return (
    <svg
      ref={svgRef}
      role="group"
      aria-label={`${LANE_LABELS[kind]} automation, ${name}`}
      aria-describedby={`${id}-help`}
      width={width}
      height={LANE_HEIGHT}
      className="block touch-none"
      data-testid="automation-lane"
    >
      <desc id={`${id}-help`}>
        Click to add a point. Drag points to move them. Focus a point: arrow keys change its value
        and position, Delete removes it.
      </desc>
      <rect
        x={0}
        y={0}
        width={width}
        height={LANE_HEIGHT}
        className="cursor-crosshair fill-muted/40"
        onPointerDown={onBackgroundDown}
      />
      {kind === "pan" && (
        <line
          x1={0}
          x2={width}
          y1={y(0)}
          y2={y(0)}
          className="stroke-border"
          strokeDasharray="2 3"
        />
      )}
      {path && (
        <path d={path} className="pointer-events-none fill-none stroke-primary" strokeWidth={1.5} />
      )}
      {points.map((p, i) => (
        <circle
          key={`${p.bar}-${i}`}
          cx={x(p.bar)}
          cy={y(p.value)}
          r={focused === i ? 5.5 : 4.5}
          tabIndex={0}
          role="slider"
          aria-label={`${LANE_LABELS[kind]} point at bar ${(p.bar + 1).toFixed(2).replace(/\.?0+$/, "")}`}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={p.value}
          aria-valuetext={describeAutomationValue(kind, p.value)}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Delete"
          data-testid="automation-point"
          onPointerDown={(e) => onPointDown(e, i)}
          onPointerMove={onPointMove}
          onPointerUp={onPointUp}
          onFocus={() => setFocused(i)}
          onBlur={() => setFocused(null)}
          onKeyDown={(e) => onPointKey(e, i)}
          className={cn(
            "cursor-grab fill-card stroke-primary outline-none focus-visible:stroke-[3]",
          )}
          strokeWidth={2}
        />
      ))}
    </svg>
  );
}
