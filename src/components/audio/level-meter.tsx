import { meterPosition, useMeter } from "@/lib/audio/meter-store";
import type { EngineMeters } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * A peak meter (-60…0 dB) fed by the engine while playing: green, amber from
 * -12 dB, red near clipping. Quiet for assistive technology apart from its
 * value (which changes many times a second, so it is not announced).
 */
export function LevelMeter({
  select,
  label,
  orientation = "horizontal",
  className,
}: {
  select: (meters: EngineMeters) => number;
  label: string;
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  const peak = useMeter(select);
  const shown = meterPosition(peak);
  const percent = Math.round(shown * 100);
  const color = shown > 0.95 ? "bg-red-600" : shown > 0.8 ? "bg-amber-500" : "bg-emerald-600";
  const vertical = orientation === "vertical";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={peak > 0 ? `${Math.round(20 * Math.log10(peak))} dB` : "Silent"}
      data-level={percent}
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted",
        vertical ? "w-1.5" : "h-1",
        className,
      )}
    >
      <div
        className={cn(
          "absolute rounded-sm",
          color,
          vertical ? "inset-x-0 bottom-0" : "inset-y-0 left-0",
        )}
        style={vertical ? { height: `${percent}%` } : { width: `${percent}%` }}
      />
    </div>
  );
}
