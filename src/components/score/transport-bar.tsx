import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { LoaderCircleIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeTime, formatTime } from "@/lib/score/format";
import type { PlaybackPosition } from "@/lib/score/player";

/**
 * Shows the bar being played; type a bar number and press Enter to start
 * there (the keyboard alternative to clicking a bar in the score).
 */
function BarField({
  bar,
  barCount,
  onSeek,
}: {
  bar: number;
  barCount: number;
  onSeek: (barIndex: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const number = Number.parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(number)) onSeek(Math.min(barCount, Math.max(1, number)) - 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setDraft(null);
  };

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        Bar
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={barCount}
        value={draft ?? String(bar + 1)}
        onFocus={(event) => {
          setDraft(String(bar + 1));
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        className="h-8 w-16 tabular-nums"
      />
      <span className="text-muted-foreground tabular-nums">/ {barCount}</span>
    </div>
  );
}

export function TransportBar({
  ready,
  playing,
  position,
  bar,
  barCount,
  onPlayPause,
  onStop,
  onSeekBar,
  practice,
}: {
  ready: boolean;
  playing: boolean;
  position: PlaybackPosition;
  bar: number;
  barCount: number;
  onPlayPause: () => void;
  onStop: () => void;
  onSeekBar: (barIndex: number) => void;
  /** Practice tools (loop, speed...), after the transport controls. */
  practice?: ReactNode;
}) {
  return (
    // One row that scrolls sideways in narrow windows, wrapping from `sm` up.
    <div className="flex shrink-0 items-center gap-x-4 gap-y-2 overflow-x-auto border-t bg-background px-4 py-2 *:shrink-0 sm:flex-wrap sm:px-6">
      <div className="flex items-center gap-1">
        <Button
          size="icon-lg"
          onClick={onPlayPause}
          disabled={!ready}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button
          size="icon-lg"
          variant="outline"
          onClick={onStop}
          disabled={!ready}
          aria-label="Stop"
          title="Stop"
        >
          <SquareIcon />
        </Button>
      </div>

      <span
        role="timer"
        aria-label={`Position: ${describeTime(position.currentMs)} of ${describeTime(position.endMs)}`}
        className="text-sm tabular-nums"
      >
        {formatTime(position.currentMs)} / {formatTime(position.endMs)}
      </span>

      <BarField bar={bar} barCount={barCount} onSeek={onSeekBar} />

      {position.bpm > 0 && (
        <span className="text-sm text-muted-foreground tabular-nums">{position.bpm} BPM</span>
      )}

      {!ready && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Loading instrument sounds…
        </p>
      )}
      {practice}
    </div>
  );
}
