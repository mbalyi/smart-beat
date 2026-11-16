import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { formatTime, parseTime } from "@/lib/audio-lanes/lane-transcribe";
import type { LaneRange } from "@/lib/audio-lanes/lane-transcribe-request";

/** A time field that takes what is typed and commits it when it is a time (on blur or Enter). */
function TimeField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (ms: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(formatTime(value));
  const [bad, setBad] = useState(false);
  // Follows the value when it changes from the slider.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(formatTime(value));
    setBad(false);
  }
  const commit = () => {
    const ms = parseTime(text);
    if (ms === null) {
      setBad(true);
      return;
    }
    setBad(false);
    onCommit(ms);
    setText(formatTime(ms));
  };
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase"
      >
        {label}
      </label>
      <Input
        id={id}
        value={text}
        inputMode="decimal"
        aria-invalid={bad || undefined}
        className="w-28 rounded-md font-mono"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

/**
 * The span of the audio to convert: two time fields and two sliders over the length of the lane
 * (native sliders, so the arrow keys, Page keys, Home and End work). The strip under them shows
 * where the span is.
 */
export function RangeStrip({
  extent,
  value,
  onChange,
}: {
  /** The audio the lane holds, on the timeline. */
  extent: LaneRange;
  value: LaneRange;
  onChange: (range: LaneRange) => void;
}) {
  const total = Math.max(1, extent.endMs - extent.startMs);
  const left = ((value.startMs - extent.startMs) / total) * 100;
  const width = ((value.endMs - value.startMs) / total) * 100;
  const step = total > 120_000 ? 1000 : 100;
  const clamp = (ms: number) => Math.min(extent.endMs, Math.max(extent.startMs, ms));
  const setStart = (ms: number) => {
    const startMs = clamp(ms);
    onChange({ startMs, endMs: Math.max(value.endMs, startMs + step) });
  };
  const setEnd = (ms: number) => {
    const endMs = clamp(ms);
    onChange({ startMs: Math.min(value.startMs, endMs - step), endMs });
  };
  return (
    <div className="flex flex-col gap-3" data-tour="lane-to-tab-range">
      <div className="flex flex-wrap items-end gap-4">
        <TimeField label="From" value={value.startMs} onCommit={setStart} />
        <TimeField label="To" value={value.endMs} onCommit={setEnd} />
      </div>
      <div className="relative h-2 rounded-full bg-muted" aria-hidden="true">
        <div
          className="absolute inset-y-0 rounded-full bg-primary shadow-[0_0_10px_color-mix(in_oklab,var(--primary)_60%,transparent)]"
          style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="w-12 shrink-0">Start</span>
          <input
            type="range"
            className="h-1.5 min-w-0 flex-1 accent-primary"
            min={extent.startMs}
            max={extent.endMs}
            step={step}
            value={Math.min(Math.max(value.startMs, extent.startMs), extent.endMs)}
            aria-label="Start of the part to convert"
            aria-valuetext={formatTime(value.startMs)}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-12 shrink-0">End</span>
          <input
            type="range"
            className="h-1.5 min-w-0 flex-1 accent-primary"
            min={extent.startMs}
            max={extent.endMs}
            step={step}
            value={Math.min(Math.max(value.endMs, extent.startMs), extent.endMs)}
            aria-label="End of the part to convert"
            aria-valuetext={formatTime(value.endMs)}
            onChange={(event) => setEnd(Number(event.target.value))}
          />
        </label>
      </div>
    </div>
  );
}
