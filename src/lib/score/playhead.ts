import { useSyncExternalStore } from "react";

/**
 * Where playback is, as a fractional bar. It changes many times a second, so it lives outside React
 * state: only the playhead lines subscribe, and the rest of the workspace is not drawn again.
 */
export class PlayheadStore {
  private bar = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = () => this.bar;

  set(bar: number) {
    if (bar === this.bar) return;
    this.bar = bar;
    for (const listener of this.listeners) listener();
  }
}

/** The playhead's bar position; it redraws the caller whenever it moves. */
export function usePlayheadBar(store: PlayheadStore): number {
  return useSyncExternalStore(store.subscribe, store.get);
}
