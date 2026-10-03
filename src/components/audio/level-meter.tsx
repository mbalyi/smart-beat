import { describeReduction, meterPosition, useMeter } from "@/lib/audio/meter-store";
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

/** Most gain reduction a meter shows (dB). */
const MAX_REDUCTION_DB = 24;

/**
 * How much a compressor or limiter turns the sound down (#39): a bar growing
 * downwards from the top, as on hardware, fed by the engine while playing.
 */
export function GainReductionMeter({
  select,
  label,
  className,
}: {
  select: (meters: EngineMeters) => number;
  label: string;
  className?: string;
}) {
  const db = useMeter(select);
  const percent = Math.round((Math.min(db, MAX_REDUCTION_DB) / MAX_REDUCTION_DB) * 100);
  return (
    <div className={cn("flex items-center gap-2 text-xs", className)}>
      <span className="text-muted-foreground">GR</span>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={MAX_REDUCTION_DB}
        aria-valuenow={Math.round(db * 10) / 10}
        aria-valuetext={describeReduction(db)}
        data-reduction={db.toFixed(1)}
        className="relative h-1.5 flex-1 overflow-hidden rounded-sm bg-muted"
      >
        <div
          className="absolute inset-y-0 right-0 rounded-sm bg-amber-500"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-14 text-right tabular-nums">{describeReduction(db)}</span>
    </div>
  );
}
