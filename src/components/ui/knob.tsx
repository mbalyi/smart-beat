import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

/** Pixels of vertical drag for the whole range (Shift: ten times finer). */
const DRAG_RANGE_PX = 160;
/** The arc covers 270°, from 7:30 to 4:30 on a clock face. */
const SWEEP = 270;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function snap(value: number, min: number, step: number) {
  const snapped = Math.round((value - min) / step) * step + min;
  // Avoid 0.30000000000000004.
  return Number(snapped.toFixed(6));
}

function arc(radius: number, from: number, to: number) {
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [24 + radius * Math.cos(rad), 24 + radius * Math.sin(rad)];
  };
  const [x1, y1] = point(from);
  const [x2, y2] = point(to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

/**
 * A rotary knob, as on a pedal or amp. A slider for assistive technology:
 * arrow keys change it by a step, Page Up/Down by ten, Home/End go to the
 * ends; with the mouse, drag up or down (Shift for fine changes) and
 * double-click to reset.
 */
export function Knob({
  label,
  valueText,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  defaultValue,
  onValueChange,
  onValueCommit,
  onDraggingChange,
  disabled,
  size = "md",
  showLabel = true,
  caption,
  className,
}: {
  /** Accessible name, e.g. "Drive gain". */
  label: string;
  /** Spoken and shown value, e.g. "60%" or "4.0 dB". */
  valueText: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Double-click resets to this (defaults to the middle for ranges around 0, else min). */
  defaultValue?: number;
  onValueChange: (value: number) => void;
  /** When a change is finished (pointer up, or each key press). */
  onValueCommit?: (value: number) => void;
  /** Whether the user is dragging the dial (a pointer is down on it). */
  onDraggingChange?: (dragging: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Show the label under the knob (the accessible name is set either way). */
  showLabel?: boolean;
  /** The visible label, when it should differ from the end of `label` (e.g. "1 kHz"). */
  caption?: string;
  className?: string;
}) {
  const drag = useRef<{ y: number; value: number; moved: boolean } | null>(null);
  const range = max - min || 1;
  const ratio = clamp((value - min) / range, 0, 1);
  const angle = -SWEEP / 2 + ratio * SWEEP;
  const resetTo = defaultValue ?? (min < 0 && max > 0 ? 0 : min);

  const set = (next: number, commit: boolean) => {
    const v = clamp(snap(next, min, step), min, max);
    if (v !== value) onValueChange(v);
    if (commit) onValueCommit?.(v);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disabled) return;
    const big = Math.max(step, range / 10);
    const keys: Record<string, number | undefined> = {
      ArrowUp: value + step,
      ArrowRight: value + step,
      ArrowDown: value - step,
      ArrowLeft: value - step,
      PageUp: value + big,
      PageDown: value - big,
      Home: min,
      End: max,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set(next, true);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    drag.current = { y: event.clientY, value, moved: false };
    onDraggingChange?.(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const dy = start.y - event.clientY;
    if (Math.abs(dy) > 1) start.moved = true;
    const scale = event.shiftKey ? DRAG_RANGE_PX * 10 : DRAG_RANGE_PX;
    set(start.value + (dy / scale) * range, false);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    drag.current = null;
    // Only report the end of a drag that started: a pointer up on a disabled
    // knob never called onDraggingChange(true).
    if (start) onDraggingChange?.(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (start?.moved) onValueCommit?.(value);
  };

  const px = size === "sm" ? "size-8" : "size-11";
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-0.5 select-none",
        disabled && "opacity-50",
        className,
      )}
    >
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText}
        aria-disabled={disabled || undefined}
        title={`${label}: ${valueText}`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => !disabled && set(resetTo, true)}
        className={cn(
          px,
          "cursor-ns-resize touch-none rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        <svg viewBox="0 0 48 48" className="size-full" aria-hidden="true">
          <path
            d={arc(20, -SWEEP / 2, SWEEP / 2)}
            className="fill-none stroke-muted"
            strokeWidth={4}
            strokeLinecap="round"
          />
          {ratio > 0.001 && (
            <path
              d={arc(20, -SWEEP / 2, angle)}
              className="fill-none stroke-primary"
              strokeWidth={4}
              strokeLinecap="round"
            />
          )}
          <circle cx={24} cy={24} r={14} className="fill-card stroke-border" strokeWidth={1.5} />
          <line
            x1={24}
            y1={24}
            x2={24}
            y2={13}
            className="stroke-foreground"
            strokeWidth={2.5}
            strokeLinecap="round"
            transform={`rotate(${angle} 24 24)`}
          />
        </svg>
      </div>
      {showLabel && (
        <>
          <span className="max-w-16 truncate text-[11px] leading-tight">
            {caption ?? label.split(", ").pop()}
          </span>
          <span className="text-[10px] leading-tight text-muted-foreground tabular-nums">
            {valueText}
          </span>
        </>
      )}
    </div>
  );
}
