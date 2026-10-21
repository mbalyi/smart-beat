import type { MuscriptorSize } from "@/lib/tauri";

/**
 * The MuScriptor sizes the user can pick. The speeds are Smart Beat's own measurements on one
 * machine (Apple M2 Pro, 16 GB, 2026-10-21): one 60 s stretch of a rock recording per size, once
 * on the GPU (Metal) and once on the CPU alone, except Large on the CPU, which ran a 20 s stretch
 * because a minute would take over five. Each number is a single run with the model already
 * loaded; the first Metal run also compiles shaders, which takes about half a minute. Run
 * `cargo run --release --example muscriptor_bench` to measure another machine. RAM floors are our
 * estimates, not a source.
 */
export interface SizeInfo {
  size: MuscriptorSize;
  label: string;
  /** Download size, for the text before the status is known. */
  megabytes: number;
  /** Seconds to transcribe one minute of audio, Apple Silicon GPU (Metal). */
  gpuSeconds: number;
  /** Seconds per minute on the CPU alone. */
  cpuSeconds: number;
  /** Parameters, from the file size (float16, two bytes each). */
  params: string;
  /** Real-time factor on an Apple Silicon GPU: 2 means a minute of audio takes half a minute. */
  gpuFactor: number;
  /** Real-time factor on the CPU alone, or null when it is too slow to recommend. */
  cpuFactor: number | null;
  /** Estimated RAM floor (GB). */
  ramGb: number;
  note: string;
}

export const SIZES: readonly SizeInfo[] = [
  {
    size: "small",
    label: "Small",
    megabytes: 210,
    gpuSeconds: 13,
    cpuSeconds: 31,
    params: "~103M",
    gpuFactor: 4.5,
    cpuFactor: 2,
    ramGb: 4,
    note: "Fastest. Runs on almost any modern computer.",
  },
  {
    size: "medium",
    label: "Medium",
    megabytes: 620,
    gpuSeconds: 28,
    cpuSeconds: 77,
    params: "~307M",
    gpuFactor: 2.1,
    cpuFactor: 0.8,
    ramGb: 8,
    note: "The default. A graphics processor is recommended.",
  },
  {
    size: "large",
    label: "Large",
    megabytes: 2740,
    gpuSeconds: 85,
    cpuSeconds: 321,
    params: "~1.4B",
    gpuFactor: 0.7,
    cpuFactor: null,
    ramGb: 16,
    note: "Slowest. Needs a strong graphics processor and patience.",
  },
];

export const DEFAULT_SIZE: MuscriptorSize = "medium";

export const sizeInfo = (size: MuscriptorSize): SizeInfo =>
  SIZES.find((entry) => entry.size === size) ?? (SIZES[1] as SizeInfo);

/** "620 MB", "2.7 GB". */
export function downloadText(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.ceil(bytes / 1_000_000)} MB`;
}

const KEY = "smart-beat.muscriptor-size";
export function readSize(): MuscriptorSize {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "small" || stored === "medium" || stored === "large") return stored;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return DEFAULT_SIZE;
}
export function storeSize(size: MuscriptorSize): void {
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // Not remembered.
  }
}
