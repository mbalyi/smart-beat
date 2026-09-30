import { useId, useState, type KeyboardEvent } from "react";
import { LoaderCircleIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeTime, formatTime } from "@/lib/score/format";
import type { PlaybackPosition } from "@/lib/score/player";
import type { TrackSummary } from "@/lib/score/score";

/**
 * The bar being played; type a bar number and press Enter to start there (the
 * keyboard alternative to clicking a bar in the score).
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
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-lcd-muted">
        Bar
      </label>
      <input
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
        className="h-6 w-12 [appearance:textfield] rounded border border-white/15 bg-transparent px-1 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-sky-400 [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-lcd-muted tabular-nums">/ {barCount}</span>
    </div>
  );
}

/**
 * The dark, LCD-style display in the middle of the toolbar: the shown track
 * (a menu to switch), the bar, the time and the tempo. It keeps its look in
 * both themes, like the display of a hardware player.
 */
export function LcdDisplay({
  tracks,
  trackIndex,
  onTrackChange,
  position,
  bar,
  barCount,
  ready,
  onSeekBar,
}: {
  tracks: TrackSummary[];
  trackIndex: number;
  onTrackChange: (index: number) => void;
  position: PlaybackPosition;
  bar: number;
  barCount: number;
  ready: boolean;
  onSeekBar: (barIndex: number) => void;
}) {
  const trackLabelId = useId();

  return (
    <div
      role="group"
      aria-label="Display"
      className="flex min-w-0 flex-col gap-0.5 rounded-md border border-black/40 bg-lcd px-3 py-1.5 font-mono text-xs text-lcd-foreground shadow-inner"
    >
      <div className="flex items-center gap-2">
        <span id={trackLabelId} className="sr-only">
          Track
        </span>
        <Select value={String(trackIndex)} onValueChange={(value) => onTrackChange(Number(value))}>
          <SelectTrigger
            aria-labelledby={trackLabelId}
            size="sm"
            className="h-6 max-w-48 min-w-0 border-0 bg-transparent px-1 font-mono text-sm font-semibold text-lcd-foreground shadow-none hover:bg-white/10 dark:bg-transparent dark:hover:bg-white/10 [&_svg]:text-lcd-muted"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tracks.map((t) => (
              <SelectItem key={t.index} value={String(t.index)}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!ready && (
          <p role="status" className="flex items-center gap-1 text-lcd-muted">
            <LoaderCircleIcon
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Loading instrument sounds…
          </p>
        )}
      </div>
      <div className="flex items-center gap-x-4 gap-y-0.5 whitespace-nowrap">
        <BarField bar={bar} barCount={barCount} onSeek={onSeekBar} />
        <span
          role="timer"
          aria-label={`Position: ${describeTime(position.currentMs)} of ${describeTime(position.endMs)}`}
          className="tabular-nums"
        >
          {formatTime(position.currentMs)} / {formatTime(position.endMs)}
        </span>
        {position.bpm > 0 && (
          <span className="text-lcd-muted tabular-nums">♩ = {position.bpm} BPM</span>
        )}
      </div>
    </div>
  );
}
