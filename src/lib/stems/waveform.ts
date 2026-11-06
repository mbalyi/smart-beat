/** The outline of a waveform as one filled shape, so it takes the text colour of its theme. */
export function waveformPath(peaks: readonly number[]): string {
  const half = (peak: number) => Math.max(0.6, Math.min(1, peak) * 48);
  const top = peaks.map((peak, i) => `L${i} ${(50 - half(peak)).toFixed(1)}`);
  const bottom = peaks.map((peak, i) => `L${i} ${(50 + half(peak)).toFixed(1)}`).reverse();
  return `M0 50 ${top.join(" ")} L${peaks.length} 50 ${bottom.join(" ")} Z`;
}
