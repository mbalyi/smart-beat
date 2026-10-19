import type { MuscriptorSize } from "@/lib/tauri";

/**
 * The MuScriptor sizes the user can pick. The speeds were measured by the authors on one machine
 * (Apple M1 Pro, a 15 s clip); RAM floors are our estimates, not a source. Smart Beat's own
 * benchmarks replace them later (#150).
 */
export interface SizeInfo {
  size: MuscriptorSize;
  label: string;
  /** Download size, for the text before the status is known. */
  megabytes: number;
  /** Seconds to transcribe one minute of audio, Apple Silicon GPU (Metal). */
  gpuSeconds: number;
  /** Seconds per minute on the CPU alone, or null when nobody measured it. */
  cpuSeconds: number | null;
  /** Parameters, from the file size (float16, two bytes each). */
  params: string;
  /** Real-time factor on an Apple Silicon GPU: 2 means a minute of audio takes half a minute. */
  gpuFactor: number;
  /** Real-time factor on the CPU alone, or null when nobody measured it. */
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
    gpuSeconds: 17,
    cpuSeconds: 31,
    params: "~103M",
    gpuFactor: 3.5,
    cpuFactor: 1.9,
    ramGb: 4,
    note: "Fastest. Runs on almost any modern computer.",
  },
  {
    size: "medium",
    label: "Medium",
    megabytes: 620,
    gpuSeconds: 38,
    cpuSeconds: 87,
    params: "~307M",
    gpuFactor: 1.6,
    cpuFactor: 0.7,
    ramGb: 8,
    note: "The default. A graphics processor is recommended.",
  },
  {
    size: "large",
    label: "Large",
    megabytes: 2740,
    gpuSeconds: 125,
    cpuSeconds: null,
    params: "~1.4B",
    gpuFactor: 0.5,
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
