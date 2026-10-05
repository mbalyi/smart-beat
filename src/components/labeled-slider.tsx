import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A single-value slider with an accessible name and spoken value. Composed
 * from the Radix primitives (styled like shadcn's Slider), because the
 * generated component cannot label its thumb.
 */
export function LabeledSlider({
  label,
  valueText,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onValueChange,
  onValueCommit,
  disabled,
  orientation = "horizontal",
  className,
}: {
  /** Accessible name, e.g. "Volume, Bass". */
  label: string;
  /** Spoken value, e.g. "75%" or "40% left". */
  valueText: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** Called when the user finishes a change (pointer up or key press). */
  onValueCommit?: (value: number) => void;
  disabled?: boolean;
  /** Vertical: a fader that goes up to raise the value, as on a mixing desk. */
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      orientation={orientation}
      onValueChange={([next]) => next !== undefined && onValueChange(next)}
      onValueCommit={([next]) => next !== undefined && onValueCommit?.(next)}
      className={cn(
        "relative flex touch-none items-center select-none data-[orientation=horizontal]:h-5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-24 data-[orientation=vertical]:w-6 data-[orientation=vertical]:flex-col data-disabled:opacity-50",
        className,
      )}
    >
      <SliderPrimitive.Track className="relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1">
        <SliderPrimitive.Range className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="relative block size-3.5 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden"
      />
    </SliderPrimitive.Root>
  );
}
