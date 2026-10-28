import { vi } from "vitest";

import type {
  AudioBackend,
  AudioClip,
  AudioVoice,
  StemGains,
  StemLoop,
  StemPlayer,
  StemPlayerState,
  StemSource,
} from "@/lib/stems/player";
import type { StemKindId } from "@/lib/tauri";

/** "Audio bytes" the fake backend decodes: the clip's length in seconds. */
export const clipBytes = (seconds: number): ArrayBuffer => {
  const bytes = new ArrayBuffer(4);
  new DataView(bytes).setFloat32(0, seconds);
  return bytes;
};

export interface FakeVoice extends AudioVoice {
  clip: AudioClip;
  offset: number;
  gain: number;
  loop: StemLoop | null;
  stopped: boolean;
  /** Plays to the end of the clip. */
  end(): void;
}

/**
 * Stand-in for Web Audio: a clock the test moves with `advance`, and a record of every voice
 * that was started, with the offset, gain and loop it was given.
 */
export class FakeAudioBackend implements AudioBackend {
  time = 0;
  voices: FakeVoice[] = [];
  resumed = 0;
  closed = false;
  decode = vi.fn(async (bytes: ArrayBuffer): Promise<AudioClip> => {
    const duration = new DataView(bytes).getFloat32(0);
    return { duration, peaks: (buckets) => Array.from({ length: buckets }, (_, i) => (i % 5) / 5) };
  });

  clock = () => this.time;
  advance(seconds: number) {
    this.time += seconds;
  }
  async resume() {
    this.resumed++;
  }
  start(
    clip: AudioClip,
    offset: number,
    gain: number,
    loop: StemLoop | null,
    onEnded: () => void,
  ): AudioVoice {
    const voice: FakeVoice = {
      clip,
      offset,
      gain,
      loop,
      stopped: false,
      stop: () => {
        voice.stopped = true;
      },
      setGain: (next) => {
        voice.gain = next;
      },
      end: () => {
        if (!voice.stopped) onEnded();
      },
    };
    this.voices.push(voice);
    return voice;
  }
  close() {
    this.closed = true;
  }
  /** The voices that are playing now. */
  get live() {
    return this.voices.filter((voice) => !voice.stopped);
  }
}

/** Stems of `seconds` each, and slowed mixes that are `seconds / speed` long. */
export function fakeSource(seconds: number) {
  const source = {
    renders: [] as { gains: StemGains; speed: number }[],
    failRender: null as string | null,
    readStem: vi.fn<StemSource["readStem"]>(async () => clipBytes(seconds)),
    renderMix: vi.fn<StemSource["renderMix"]>(async (gains, speed) => {
      source.renders.push({ gains, speed });
      if (source.failRender) throw new Error(source.failRender);
      return clipBytes(seconds / speed);
    }),
  };
  return source satisfies StemSource;
}

/** Stand-in for the player behind the Stem separation page. */
export class FakeStemPlayer implements StemPlayer {
  static last: FakeStemPlayer;
  state: StemPlayerState;
  private listeners = new Set<() => void>();
  livePosition: number | null = null;
  load = vi.fn(async () => {});
  play = vi.fn(async () => this.set({ playing: true }));
  pause = vi.fn(() => this.set({ playing: false }));
  stop = vi.fn(() => this.set({ playing: false, position: 0 }));
  seek = vi.fn((position: number) => this.set({ position }));
  setGains = vi.fn((_gains: StemGains) => {});
  setSpeed = vi.fn((speed: number) => this.set({ speed }));
  setLoop = vi.fn((loop: StemLoop | null) => this.set({ loop }));
  setCountIn = vi.fn((countIn: boolean) => this.set({ countIn }));
  dispose = vi.fn();

  constructor(patch: Partial<StemPlayerState> = {}) {
    this.state = {
      loaded: true,
      playing: false,
      duration: 120,
      speed: 100,
      loop: null,
      countIn: false,
      countdown: null,
      rendering: false,
      position: 0,
      error: null,
      ...patch,
    };
    FakeStemPlayer.last = this;
  }
  // An arrow function: the page hands `subscribe` to React without its player.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  position() {
    return this.livePosition ?? this.state.position;
  }
  /** Silence until the stems are loaded, as the real player draws them. */
  peaks(_kind: StemKindId, buckets: number) {
    return Array.from({ length: buckets }, (_, i) => (this.state.loaded ? (i % 7) / 7 : 0));
  }
  /** Changes the state the way the real player does and tells the page. */
  set(patch: Partial<StemPlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
