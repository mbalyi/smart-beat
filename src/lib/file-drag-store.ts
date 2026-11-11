import type { DropPoint } from "@/lib/audio-lanes/drop-target";

/**
 * Where files dragged from the OS are over the window right now. The pointer moves many times a
 * second, so it is a store (like the playhead): only the parts that follow it re-render.
 */
export class FileDragStore {
  private point: DropPoint | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The pointer's place in CSS pixels, or null when nothing is dragged over the window. */
  get position(): DropPoint | null {
    return this.point;
  }

  set(point: DropPoint | null) {
    if (point?.x === this.point?.x && point?.y === this.point?.y) return;
    this.point = point;
    for (const listener of this.listeners) listener();
  }
}

/** What is being dragged over the window, for the parts that react to it. */
export interface FileDragState {
  readonly store: FileDragStore;
  /** Every dragged file is audio (an mp3, wav…): it can go on a lane. */
  readonly audio: boolean;
  /** How many files are dragged. */
  readonly count: number;
}
