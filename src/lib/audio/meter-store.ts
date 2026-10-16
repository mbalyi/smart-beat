/**
 * Level meters while playing, or while the monitor track listens (native engine). The engine
 * reports peaks about
 * 40 times a second; keeping them out of React state means only the meters
 * redraw, not the whole workspace.
 */
import { useSyncExternalStore } from "react";

import type { EngineMeters } from "@/lib/tauri";

export interface MeterStore {
  get: () => EngineMeters;
  set: (meters: EngineMeters) => void;
  subscribe: (listener: () => void) => () => void;
}

const SILENT: EngineMeters = { tracks: [], master: 0, drums: [], backing: 0 };

/** How fast a meter falls back (share kept per update, ~40 updates per second). */
export const FALL = 0.82;

const fall = (next: number | undefined, previous: number | undefined) => {
  const value = Math.max(next ?? 0, (previous ?? 0) * FALL);
  return value < 0.001 ? 0 : value;
};

/** New peaks, falling back smoothly from the previous ones (like a desk meter). */
export function smoothMeters(next: EngineMeters, previous: EngineMeters): EngineMeters {
  return {
    tracks: next.tracks.map((v, i) => fall(v, previous.tracks[i])),
    master: fall(next.master, previous.master),
    drums: (next.drums ?? []).map((row, t) => row.map((v, e) => fall(v, previous.drums?.[t]?.[e]))),
    backing: fall(next.backing, previous.backing),
    ...(next.monitor !== undefined && { monitor: fall(next.monitor, previous.monitor) }),
    ...(next.monitorInput !== undefined && {
      monitorInput: fall(next.monitorInput, previous.monitorInput),
    }),
    ...(next.reduction && {
      reduction: {
        tracks: next.reduction.tracks.map((row, t) =>
          row.map((v, i) => fall(v, previous.reduction?.tracks[t]?.[i])),
        ),
        master: next.reduction.master.map((v, i) => fall(v, previous.reduction?.master[i])),
        ...(next.reduction.monitor && {
          monitor: next.reduction.monitor.map((v, i) => fall(v, previous.reduction?.monitor?.[i])),
        }),
      },
    }),
  };
}

export function createMeterStore(): MeterStore {
  let current = SILENT;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (meters) => {
      current = smoothMeters(meters, current);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's meters (one engine at a time). */
export const meters = createMeterStore();

/** One level from the store (re-renders only when it changes). */
export function useMeter(select: (meters: EngineMeters) => number, store: MeterStore = meters) {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.get()),
    () => 0,
  );
}

/** Peak (0…1) to a meter position (0…1) on a -60…0 dB scale. */
export function meterPosition(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** "-4.5 dB" of gain reduction (#39), or "No reduction". */
export const describeReduction = (db: number) =>
  db > 0.05 ? `-${db.toFixed(1)} dB` : "No reduction";
