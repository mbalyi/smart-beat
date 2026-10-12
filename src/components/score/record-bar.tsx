import { CircleIcon, SquareIcon } from "lucide-react";

import { LevelMeter } from "@/components/score/level-meter";
import { Button } from "@/components/ui/button";
import type { RecordPhase } from "@/hooks/use-record-to-tab";
import { formatElapsed } from "@/lib/audio/level";

/**
 * The slim bar shown while a take is recorded or turned into notes. Space or Escape stops the
 * take; Escape during the count-in throws it away.
 */
export function RecordBar({
  phase,
  level,
  onStop,
  onCancel,
}: {
  phase: RecordPhase;
  level: number;
  onStop: () => void;
  /** Stops the transcription. */
  onCancel: () => void;
}) {
  if (phase.kind === "idle") return null;
  return (
    <section
      aria-label="Recording"
      className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-popover px-4 py-2 text-popover-foreground shadow-lg"
    >
      {phase.kind === "recording" ? (
        <>
          <CircleIcon
            aria-hidden="true"
            className="size-3 shrink-0 animate-pulse fill-destructive text-destructive"
          />
          <span role="status" className="text-sm font-medium">
            {phase.countingIn ? "Count-in…" : "Recording"}
          </span>
          <span className="text-sm tabular-nums" aria-label="Time recorded">
            {formatElapsed(phase.elapsed)}
          </span>
          <LevelMeter level={level} className="min-w-16 flex-1" />
          <Button size="sm" onClick={onStop}>
            <SquareIcon data-icon="inline-start" className="fill-current" />
            Stop
          </Button>
          <p className="basis-full text-xs text-muted-foreground">
            {phase.countingIn
              ? "Press Escape to throw this take away, or Space to stop."
              : "Press Space or Escape to stop."}
          </p>
        </>
      ) : (
        <>
          <span role="status" className="text-sm font-medium">
            Transcribing…
          </span>
          <span aria-hidden="true" className="w-10 text-sm tabular-nums">
            {Math.round(phase.fraction * 100)}%
          </span>
          <progress
            aria-label="Transcription progress"
            max={1}
            value={phase.fraction}
            className="h-2 min-w-16 flex-1 overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
          />
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
    </section>
  );
}
