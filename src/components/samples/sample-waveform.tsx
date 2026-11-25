import { useEffect, useRef } from "react";

import { waveformPath } from "@/lib/stems/waveform";

/** The small filled waveform of a sample, in the lane colour of the clips it will become. */
export function SampleWaveform({
  peaks,
  className,
}: {
  /** 0 to 255 per bin, or null while the file is not measured yet. */
  peaks: readonly number[] | null;
  className?: string;
}) {
  if (!peaks || peaks.length === 0) {
    return <span aria-hidden="true" className={className} data-testid="sample-waveform-empty" />;
  }
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className={className}
      data-testid="sample-waveform"
    >
      <path d={waveformPath(peaks.map((p) => p / 255))} fill="currentColor" />
    </svg>
  );
}

/**
 * A thin line that sweeps across the waveform from left to right while the sample plays. It is
 * driven by the clock (the start time and the length), not by the engine, and moves with a
 * transform only. Decoration: the row already says "playing" to assistive technology.
 */
export function SamplePlayhead({
  startedAt,
  durationMs,
}: {
  /** `performance.now()` when playback began. */
  startedAt: number;
  durationMs: number;
}) {
  const line = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = line.current;
    if (!el || durationMs <= 0) return;
    const place = (progress: number) => {
      const width = el.parentElement?.clientWidth ?? 0;
      el.style.transform = `translateX(${progress * width}px)`;
    };
    place(0);
    let frame = 0;
    const tick = () => {
      const progress = Math.min(1, Math.max(0, (performance.now() - startedAt) / durationMs));
      place(progress);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [startedAt, durationMs]);
  return (
    <span
      ref={line}
      aria-hidden="true"
      data-testid="sample-playhead"
      className="pointer-events-none absolute inset-y-0 left-0 w-0.5 rounded-full bg-primary will-change-transform"
    />
  );
}
