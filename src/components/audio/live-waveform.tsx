import { useEffect, useRef, useState } from "react";

import { levelWords } from "@/lib/audio/level";
import { cn } from "@/lib/utils";

/** How often a new bar comes in on the right (ms). */
const STEP_MS = 60;
/** The shortest bar, so that silence still shows a line. */
const FLOOR = 0.06;

/**
 * The level of a recording input (0…1) as a live waveform: a row of bars, newest on the right,
 * in the brand purple. Turns red near clipping. For assistive technology it is a meter with
 * the current level.
 */
export function LiveWaveform({
  level,
  bars = 48,
  label = "Input level",
  className,
}: {
  level: number;
  /** How many bars the row holds. */
  bars?: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, level));
  const latest = useRef(clamped);
  const [history, setHistory] = useState<number[]>(() => Array<number>(bars).fill(0));
  useEffect(() => {
    latest.current = clamped;
  });
  useEffect(() => {
    const timer = setInterval(
      () => setHistory((shown) => [...shown.slice(shown.length - bars + 1), latest.current]),
      STEP_MS,
    );
    return () => clearInterval(timer);
  }, [bars]);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuetext={levelWords(clamped)}
      className={cn("flex h-12 items-center gap-0.5 overflow-hidden", className)}
    >
      {history.map((value, i) => (
        <span
          key={i}
          aria-hidden="true"
          data-bar=""
          className={cn(
            "min-w-0 flex-1 rounded-full",
            value >= 0.95 ? "bg-destructive" : value > 0 ? "bg-brand" : "bg-brand/25",
          )}
          style={{ height: `${Math.max(FLOOR, value) * 100}%` }}
        />
      ))}
    </div>
  );
}
