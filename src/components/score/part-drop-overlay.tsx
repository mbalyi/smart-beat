import type { PartHighlight } from "@/lib/score/part-drop-registry";
import { cn } from "@/lib/utils";

/**
 * Outlines the bars a transcribed part would land on while it is carried over the score (#235):
 * a dashed frame around each covered bar, a line at the bar it starts on, and, in a warning
 * style, why it cannot be dropped there. Decorative: the dialog's live region says it in words.
 */
export function PartDropOverlay({ highlight }: { highlight: PartHighlight }) {
  const first = highlight.boxes[0];
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      aria-hidden="true"
      data-testid="part-drop-overlay"
      data-invalid={highlight.invalid || undefined}
    >
      {highlight.boxes.map((box, i) => (
        <div
          key={i}
          data-testid="part-drop-bar"
          className={cn(
            "absolute rounded-sm border-2 border-dashed",
            highlight.invalid
              ? "border-amber-500 bg-amber-400/20"
              : "border-primary bg-primary/15 shadow-[0_0_10px_color-mix(in_oklab,var(--primary)_50%,transparent)]",
          )}
          style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        />
      ))}
      {first && highlight.startX !== null && !highlight.invalid && (
        <div
          data-testid="part-drop-start"
          className="absolute w-1 rounded-full bg-primary"
          style={{ left: highlight.startX - 2, top: first.y - 4, height: first.h + 8 }}
        />
      )}
      {first && (
        <div
          className={cn(
            "absolute -translate-y-full rounded-t-md px-1.5 text-[11px] leading-5 font-semibold whitespace-nowrap",
            highlight.invalid ? "bg-amber-500 text-black" : "bg-primary text-primary-foreground",
          )}
          style={{ left: first.x, top: first.y }}
        >
          {highlight.text}
        </div>
      )}
    </div>
  );
}
