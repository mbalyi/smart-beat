import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface Swatch {
  name: string;
  hex: string;
}

/**
 * A grid of colour swatches (toggle buttons): the chosen one is pressed and ticked, so the choice
 * never depends on telling colours apart. `display` turns a swatch into the colour it is drawn
 * with (kept readable on both themes).
 */
export function ColorSwatches({
  label,
  swatches,
  chosen,
  onChoose,
  display,
  columns = 6,
  size = "md",
}: {
  label: string;
  swatches: readonly Swatch[];
  chosen: string | null;
  onChoose: (hex: string) => void;
  display: (hex: string) => string;
  columns?: number;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {swatches.map((swatch) => {
        const on = chosen === swatch.hex;
        return (
          <button
            key={swatch.hex}
            type="button"
            aria-pressed={on}
            aria-label={swatch.name}
            title={swatch.name}
            onClick={() => onChoose(swatch.hex)}
            className={cn(
              "flex items-center justify-center rounded-md border-2 transition-transform outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95 motion-reduce:transition-none",
              size === "sm" ? "size-7" : "size-9",
              on ? "border-foreground" : "border-transparent hover:border-muted-foreground",
            )}
            style={{ backgroundColor: display(swatch.hex) }}
          >
            {on && (
              <CheckIcon
                className={cn("text-black", size === "sm" ? "size-4" : "size-5")}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
