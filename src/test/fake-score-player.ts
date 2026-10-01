import { act } from "@testing-library/react";
import { vi } from "vitest";

import type { ScorePlayerCallbacks, ScorePlayerOptions } from "@/lib/score/player";

/**
 * Stand-in for `ScorePlayer` (alphaTab needs a real browser). Records what the
 * UI asks it to do and lets tests play the part of alphaTab via `emit`.
 *
 * Use with:
 * `vi.mock("@/lib/score/player", async () => ({ ScorePlayer: (await import("@/test/fake-score-player")).FakeScorePlayer }))`
 */
export class FakeScorePlayer {
  static instances: FakeScorePlayer[] = [];

  static get last(): FakeScorePlayer {
    const player = FakeScorePlayer.instances.at(-1);
    if (!player) throw new Error("No ScorePlayer was created");
    return player;
  }

  readonly options: ScorePlayerOptions;
  readonly callbacks: ScorePlayerCallbacks;
  showTrack = vi.fn();
  setView = vi.fn();
  setLayout = vi.fn();
  setMix = vi.fn();
  setSoundFont = vi.fn();
  playPause = vi.fn();
  stop = vi.fn();
  pause = vi.fn();
  renderAudio = vi.fn(async (onProgress?: (fraction: number) => void) => {
    onProgress?.(1);
    return { samples: new Float32Array([0, 0.5, -0.5, 1]), sampleRate: 44_100, channels: 2 };
  });
  setZoom = vi.fn();
  /** The view put back after printing. */
  restoreAfterPrint = vi.fn();
  showForPrint = vi.fn((_tracks: number[], _scale: number) => this.restoreAfterPrint);
  previewDrum = vi.fn();
  seekToBar = vi.fn();
  destroy = vi.fn();
  refresh = vi.fn();
  setEditing = vi.fn();
  setLoop = vi.fn();
  setSpeed = vi.fn();
  setMetronome = vi.fn();
  setCountIn = vi.fn();
  seekToBeat = vi.fn();
  /** Where beats and notes are "drawn": one fixed box each. */
  beatRects = vi.fn(() => [{ x: 10, y: 20, w: 30, h: 100 }]);
  noteRects = vi.fn(() => [{ x: 15, y: 60, w: 8, h: 10 }]);

  constructor(options: ScorePlayerOptions, callbacks: ScorePlayerCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
    FakeScorePlayer.instances.push(this);
  }

  /** Calls one of the UI's callbacks, as alphaTab would. */
  emit<K extends keyof ScorePlayerCallbacks>(
    name: K,
    ...args: Parameters<NonNullable<ScorePlayerCallbacks[K]>>
  ) {
    act(() => {
      (this.callbacks[name] as ((...a: typeof args) => void) | undefined)?.(...args);
    });
  }

  /** Finishes rendering and loading the SoundFont. */
  becomeReady() {
    this.emit("onRenderingChange", false);
    this.emit("onPositionChange", { currentMs: 0, endMs: 12_000, bpm: 60 });
    this.emit("onReadyChange", true);
  }
}
