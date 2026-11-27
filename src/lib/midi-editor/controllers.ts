import type { AudioLane, MidiCc } from "@/lib/tauri";

/** What a controller lane shows and edits. */
export type ControllerKind =
  { type: "velocity" } | { type: "cc"; cc: number } | { type: "bend" } | { type: "pressure" };

/** A lane kind as text. */
export function controllerLabel(kind: ControllerKind): string {
  switch (kind.type) {
    case "velocity":
      return "Velocity";
    case "bend":
      return "Pitch bend";
    case "pressure":
      return "Channel pressure";
    case "cc":
      return CC_NAMES[kind.cc] ? `CC ${kind.cc} ${CC_NAMES[kind.cc]}` : `CC ${kind.cc}`;
  }
}

/** Names of the common controllers. */
export const CC_NAMES: Readonly<Record<number, string>> = {
  1: "Modulation",
  2: "Breath",
  4: "Hi-hat pedal",
  7: "Volume",
  10: "Pan",
  11: "Expression",
  64: "Sustain",
  71: "Resonance",
  74: "Brightness",
};

/** A controller event matches a lane. */
export function inLane(kind: ControllerKind, cc: MidiCc): boolean {
  if (kind.type === "cc") return cc.kind === "cc" && cc.cc === kind.cc;
  return cc.kind === kind.type;
}

/** A lane plays drums (its notes are hits on named rows). */
export const isDrumLane = (lane: Pick<AudioLane, "instrument">): boolean =>
  lane.instrument?.type === "drums" ||
  lane.instrument?.type === "kit" ||
  lane.instrument?.type === "pads";
