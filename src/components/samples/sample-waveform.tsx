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
