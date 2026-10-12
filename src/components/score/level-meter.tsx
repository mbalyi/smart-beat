import { levelWords } from "@/lib/audio/level";
import { cn } from "@/lib/utils";

/** The level of an audio input, 0…1: a bar that fills from the left. */
export function LevelMeter({
  level,
  label = "Input level",
  className,
}: {
  level: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, level));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={levelWords(clamped)}
      className={cn("relative h-3 overflow-hidden rounded-full border bg-muted", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          clamped >= 0.95 ? "bg-destructive" : clamped >= 0.85 ? "bg-amber-500" : "bg-green-600",
        )}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}
