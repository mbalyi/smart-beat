/** Labels and formatting for the audio track. */
import type { BackingFilter } from "@/lib/tauri";

export const FILTER_LABELS: Record<BackingFilter, string> = {
  off: "No filter",
  bassIsolate: "Bass only",
  guitarBand: "Guitar range",
  centreCut: "Remove the centre (vocals)",
};

/** "1:02.50" */
export function formatMs(ms: number) {
  const s = Math.max(0, ms) / 1000;
  const minutes = Math.floor(s / 60);
  return `${minutes}:${(s - minutes * 60).toFixed(2).padStart(5, "0")}`;
}
