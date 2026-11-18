import type { SampleFile } from "./types";

/** The files whose name contains every word of `query` (case does not matter). */
export function filterSamples<T>(
  items: readonly T[],
  query: string,
  file: (item: T) => Pick<SampleFile, "name" | "rel">,
): readonly T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const f = file(item);
    const hay = `${f.name} ${f.rel}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "0.42 s", "7.1 s", "1:12": short lengths keep their decimals. */
export function formatSampleLength(ms: number | null): string {
  if (ms === null) return "–";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(s < 1 ? 2 : 1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** "44.1 kHz" for 44100. */
export function formatRate(rate: number | null): string {
  if (!rate) return "";
  return `${Number((rate / 1000).toFixed(1))} kHz`;
}

/** The grey line under a sample's name: "7.1 s · 44.1 kHz · FLAC". */
export function sampleMeta(file: SampleFile): string {
  return [formatSampleLength(file.durationMs), formatRate(file.sampleRate), file.ext.toUpperCase()]
    .filter(Boolean)
    .join(" · ");
}

/** "412 MB", "1.8 GB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** "1 sample", "1,204 samples". */
export function countLabel(count: number): string {
  return `${count.toLocaleString("en")} ${count === 1 ? "sample" : "samples"}`;
}
