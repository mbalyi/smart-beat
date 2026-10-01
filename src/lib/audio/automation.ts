/** Automation lanes: names and how their values read. */
import { describePan, describeVolume } from "@/lib/score/mixer";
import type { AutomationLaneKind } from "@/lib/tauri";

export const LANE_LABELS: Record<AutomationLaneKind, string> = {
  volume: "Volume",
  pan: "Pan",
  mute: "Mute",
};

export function describeAutomationValue(kind: AutomationLaneKind, value: number) {
  if (kind === "volume") return describeVolume(value);
  if (kind === "pan") return describePan(value);
  return value >= 0.5 ? "Muted" : "On";
}
