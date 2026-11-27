import type { MidiControlAction, MidiControlMap } from "@/lib/tauri";

/** The app actions a knob or button can run, in plain words. */
export const CONTROL_ACTIONS: readonly { value: MidiControlAction; label: string }[] = [
  { value: "playPause", label: "Play / pause" },
  { value: "stop", label: "Stop" },
  { value: "record", label: "Record on the armed lane" },
  { value: "metronome", label: "Metronome on / off" },
  { value: "loop", label: "Loop on / off" },
  { value: "laneVolume", label: "Armed lane volume (knob)" },
  { value: "lanePan", label: "Armed lane pan (knob)" },
  { value: "masterVolume", label: "Master volume (knob)" },
  { value: "speed", label: "Speed trainer (knob)" },
];

/** A control as text: "CC 20 on channel 1 → Armed lane volume". */
export function controlDescription(c: MidiControlMap): string {
  const what = c.source === "cc" ? `Knob CC ${c.number}` : `Button note ${c.number}`;
  const label = CONTROL_ACTIONS.find((a) => a.value === c.action)?.label ?? c.action;
  return `${what} on channel ${c.chan + 1} → ${label}`;
}

/** A knob's new value: a position (0 … 1) or a relative step added to the current value. */
export function knobValue(
  current: number,
  event: { value: number | null; relative: boolean },
  min: number,
  max: number,
): number {
  if (event.value === null) return current;
  const next = event.relative
    ? current + event.value * (max - min)
    : min + event.value * (max - min);
  return Math.min(max, Math.max(min, next));
}
