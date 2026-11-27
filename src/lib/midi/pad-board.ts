/**
 * The pad board's model (ADR 0006): the cells of a pad controller's grid, what each pad sends (the
 * device's pad map) and what it plays (a drum, or a pad of the lane's pad bank).
 */
import { DRUM_MIDI_MAP } from "@/lib/score/drum-map";
import type { MidiDeviceSettings, PadRoute, PadSlot } from "@/lib/tauri";

/** One pad of the controller as the board shows it. */
export interface PadCell {
  /** 0 … count-1 within the bank (pad 1 is 0, bottom left). */
  index: number;
  /** The note the pad sends (learned, or the bank's default). */
  sends: number;
  /** The note it plays (the pad map's target, or a pad bank key). */
  plays: number;
  label: string;
}

/**
 * The cells of one bank. A pad sends `first + bank × count + index` unless the pad map says it
 * was learned otherwise; it plays what the map routes it to, else (on a pad bank lane) the pad
 * bank key `36 + bank × count + index`, else the note it sends.
 */
export function padCells(options: {
  settings: MidiDeviceSettings | null;
  pads: readonly PadSlot[];
  count: number;
  bank: number;
  first: number;
  padLane: boolean;
}): PadCell[] {
  const { settings, pads, count, bank, first, padLane } = options;
  const routes = settings?.pads ?? [];
  return Array.from({ length: count }, (_, index) => {
    const defaultSends = Math.min(127, first + bank * count + index);
    const defaultPlays = padLane ? Math.min(127, 36 + bank * count + index) : defaultSends;
    // A learned pad: the route whose target is this cell's pad (pad banks), else the default note.
    const learned = padLane ? routes.find((r) => r.to === defaultPlays) : undefined;
    const sends = learned?.from ?? defaultSends;
    const plays = routes.find((r) => r.from === sends)?.to ?? defaultPlays;
    const slot = pads.find((p) => p.key === plays);
    const label = slot?.name || (padLane ? "Empty" : (DRUM_MIDI_MAP[plays] ?? `Note ${plays}`));
    return { index, sends, plays, label };
  });
}

/** The device routes for a set of cells (replacing earlier routes from the same notes). */
export function padsToRoutes(
  existing: readonly PadRoute[],
  cells: readonly Pick<PadCell, "sends" | "plays">[],
): PadRoute[] {
  const sent = new Set(cells.map((c) => c.sends));
  return [
    ...existing.filter((r) => !sent.has(r.from)),
    ...cells.map((c) => ({ from: c.sends, to: c.plays })),
  ];
}
