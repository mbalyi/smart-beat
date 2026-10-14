import { useRef, useState } from "react";

import { LabeledSlider } from "@/components/labeled-slider";
import { Knob } from "@/components/ui/knob";
import { describePan, panLabel, snapPan } from "@/lib/score/mixer";

/** Half the slider thumb, `size-3.5` (14px) in `LabeledSlider`. */
const THUMB_HALF_PX = 7;

/**
 * The shared pan control: -1 (hard left) to 1 (hard right). Shows the L/C/R
 * value while the pointer is over it or it has focus, snaps onto the middle
 * when dragged close to it, recentres on double-click and steps with the
 * arrow keys. One control for the track rows, the audio track, the master
 * strip and the drum mixer (where it is a knob).
 */
export function PanControl({
  label,
  value,
  valueText,
  step = 0.01,
  disabled,
  variant = "slider",
  showLabel = false,
  size = "md",
  className,
  onValueChange,
  onValueCommit,
}: {
  /** Accessible name, e.g. "Pan, Bass". */
  label: string;
  /** -1 … 1. */
  value: number;
  /** Spoken value; defaults to the L/C/R description, e.g. "Left 80%". */
  valueText?: string;
  step?: number;
  disabled?: boolean;
  /** "knob" is the rotary control the drum mixer uses. */
  variant?: "slider" | "knob";
  /**
   * Knob only: show the name and value under it. Off by default, because the
   * rows that use a knob already show the value next to it, and a slider has
   * no label of its own either.
   */
  showLabel?: boolean;
  /** Knob only: how large the dial is. */
  size?: "sm" | "md";
  className?: string;
  onValueChange: (value: number) => void;
  /** Called when a change is finished (pointer up or key press). */
  onValueCommit?: (value: number) => void;
}) {
  const [active, setActive] = useState(false);
  const dragging = useRef(false);
  const spoken = valueText ?? describePan(value);
  // Snap only while dragging: a keyboard step stays where it lands.
  const change = (next: number) => onValueChange(dragging.current ? snapPan(next) : next);
  const onDraggingChange = (on: boolean) => {
    dragging.current = on;
  };
  /** Double-click recentres, and reports the change as finished. */
  const reset = () => {
    if (disabled || value === 0) return;
    change(0);
    onValueCommit?.(0);
  };

  if (variant === "knob") {
    return (
      <Knob
        label={label}
        valueText={spoken}
        value={value}
        min={-1}
        max={1}
        step={step}
        defaultValue={0}
        disabled={disabled}
        showLabel={showLabel}
        size={size}
        className={className}
        onValueChange={change}
        onValueCommit={onValueCommit}
        onDraggingChange={onDraggingChange}
      />
    );
  }

  const ratio = Math.min(1, Math.max(0, (value + 1) / 2));
  // Radix keeps the thumb inside the track by half its width at -1 and 1
  // (`left: calc(<percent>% + <offset>px)`), so the bubble follows the same
  // path to stay over the thumb at the extremes.
  const thumbInset = THUMB_HALF_PX * (1 - ratio * 2);
  return (
    <LabeledSlider
      label={label}
      valueText={spoken}
      value={value}
      min={-1}
      max={1}
      step={step}
      disabled={disabled}
      className={className}
      onValueChange={change}
      onValueCommit={onValueCommit}
      onDraggingChange={onDraggingChange}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onDoubleClick={reset}
    >
      {active && (
        <span
          aria-hidden="true"
          data-testid="pan-value"
          className="pointer-events-none absolute -top-6 z-20 -translate-x-1/2 rounded border bg-popover px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap text-popover-foreground tabular-nums shadow-sm"
          style={{ left: `calc(${ratio * 100}% + ${thumbInset}px)` }}
        >
          {panLabel(value)}
        </span>
      )}
    </LabeledSlider>
  );
}
