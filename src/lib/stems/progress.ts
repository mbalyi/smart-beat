import type { StemProgress } from "@/lib/tauri";

/** How much of the bar each stage fills (the Rust side reports 0 to 1 within a stage). */
export const STAGES = [
  { stage: "reading", name: "Reading the song", weight: 0.1 },
  { stage: "separating", name: "Separating the parts", weight: 0.8 },
  { stage: "saving", name: "Saving the stems", weight: 0.1 },
] as const;

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** 0 to 1 over the whole job. */
export function overallProgress(progress: StemProgress | null): number {
  if (!progress) return 0;
  if (progress.stage === "done") return 1;
  let done = 0;
  for (const { stage, weight } of STAGES) {
    if (stage === progress.stage) return Math.min(1, done + weight * clamp(progress.fraction));
    done += weight;
  }
  return 0;
}
