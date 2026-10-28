import type { StemKindId } from "@/lib/tauri";

/** The practice speeds, in percent of the original (the pitch never changes). */
export const STEM_SPEEDS = [100, 90, 80, 70, 60, 50] as const;

/** How long the silent count-in is, when it is on. */
export const COUNT_IN_SECONDS = 4;

/** How long mute, solo and volume wait before a slowed mix is rendered again. */
export const RENDER_DEBOUNCE_MS = 250;

/** How long Play waits for the audio to start before it goes on without. */
const RESUME_WAIT_MS = 1000;

/** The shortest A-B loop. */
export const MIN_LOOP_SECONDS = 0.25;

/** Gain per stem, 0 to 1, with mute and solo already applied. */
export type StemGains = Partial<Record<StemKindId, number>>;

/** A part of the song that repeats, in seconds of the song. */
export interface StemLoop {
  start: number;
  end: number;
}

/** What the page shows. A new object after every change, so it works with `useSyncExternalStore`. */
export interface StemPlayerState {
  /** Every stem is read and decoded. */
  loaded: boolean;
  playing: boolean;
  duration: number;
  /** The speed asked for, in percent. The sound changes to it once its mix is rendered. */
  speed: number;
  loop: StemLoop | null;
  countIn: boolean;
  /** Whole seconds left of the count-in; null when it is not running. */
  countdown: number | null;
  /** A slowed mix is being rendered. */
  rendering: boolean;
  /** Where the song is when it is not playing (see {@link StemPlayer.position} for the live one). */
  position: number;
  error: string | null;
}

/** The page's view of the player. The Web Audio one is {@link createStemPlayer}; tests use a fake. */
export interface StemPlayer {
  readonly state: StemPlayerState;
  subscribe(listener: () => void): () => void;
  /** Loads and decodes every stem. */
  load(): Promise<void>;
  /** Seconds into the song, live while playing. */
  position(): number;
  /** The loudness of a stem in `buckets` equal parts, 0 to 1, for its waveform. */
  peaks(kind: StemKindId, buckets: number): number[];
  play(): Promise<void>;
  pause(): void;
  /** Pauses and goes back to the start of the loop, or of the song. */
  stop(): void;
  seek(seconds: number): void;
  setGains(gains: StemGains): void;
  setSpeed(percent: number): void;
  /** Sets the loop (or clears it with null). A loop shorter than {@link MIN_LOOP_SECONDS} is ignored. */
  setLoop(loop: StemLoop | null): void;
  setCountIn(on: boolean): void;
  dispose(): void;
}

// --- The audio behind the player ----------------------------------------------------------

/** A decoded piece of audio. */
export interface AudioClip {
  readonly duration: number;
  peaks(buckets: number): number[];
}

/** A clip that is playing. */
export interface AudioVoice {
  stop(): void;
  setGain(gain: number): void;
}

/** The part of Web Audio the player needs, so the timing logic can be tested without it. */
export interface AudioBackend {
  /** Seconds on the audio clock. */
  clock(): number;
  /** Starts the audio after a click (browsers keep it silent until then). */
  resume(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<AudioClip>;
  /**
   * Plays `clip` from `offset` seconds. With a `loop` (in clip seconds) it repeats between its
   * ends once it gets there. `onEnded` is called when it plays to its end, never after `stop`.
   */
  start(
    clip: AudioClip,
    offset: number,
    gain: number,
    loop: StemLoop | null,
    onEnded: () => void,
  ): AudioVoice;
  close(): void;
}

/** Where the audio comes from: the Rust commands in the app. */
export interface StemSource {
  readStem(kind: StemKindId): Promise<ArrayBuffer>;
  /** The stems added with `gains` and slowed to `speed` (0.5 to 1), as a WAV file. */
  renderMix(gains: StemGains, speed: number): Promise<ArrayBuffer>;
}

/** The loudness of `samples` in `buckets` parts (0 to 1), sampling a few per part. */
export function peaksOf(channels: readonly Float32Array[], buckets: number): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0 || buckets <= 0) return Array.from({ length: Math.max(0, buckets) }, () => 0);
  const size = length / buckets;
  const step = Math.max(1, Math.floor(size / 64));
  const out: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = Math.floor(bucket * size);
    const to = Math.min(length, Math.max(from + 1, Math.floor((bucket + 1) * size)));
    let peak = 0;
    for (const channel of channels) {
      for (let i = from; i < to; i += step) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
    }
    out.push(Math.min(1, peak));
  }
  return out;
}

/** Web Audio in this webview; null where there is none (some test environments). */
export function createWebAudioBackend(): AudioBackend | null {
  if (typeof window === "undefined") return null;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return null;
  }
  type WebClip = AudioClip & { buffer: AudioBuffer };
  return {
    clock: () => context.currentTime,
    resume: async () => {
      if (context.state !== "running") await context.resume();
    },
    async decode(bytes) {
      const buffer = await context.decodeAudioData(bytes);
      const clip: WebClip = {
        buffer,
        duration: buffer.duration,
        peaks: (buckets) =>
          peaksOf(
            Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
            buckets,
          ),
      };
      return clip;
    },
    start(clip, offset, gain, loop, onEnded) {
      const source = context.createBufferSource();
      source.buffer = (clip as WebClip).buffer;
      if (loop) {
        source.loop = true;
        source.loopStart = loop.start;
        source.loopEnd = loop.end;
      }
      const node = context.createGain();
      node.gain.value = gain;
      source.connect(node).connect(context.destination);
      source.onended = onEnded;
      source.start(0, offset);
      return {
        stop() {
          source.onended = null;
          try {
            source.stop();
          } catch {
            // Already stopped.
          }
          source.disconnect();
          node.disconnect();
        },
        // A short ramp keeps a mute from clicking.
        setGain: (value) => node.gain.setTargetAtTime(value, context.currentTime, 0.01),
      };
    },
    close() {
      void context.close().catch(() => {});
    },
  };
}

// --- The player ---------------------------------------------------------------------------

interface Mix {
  key: string;
  speed: number;
  clip: AudioClip;
}

const speedKey = (kinds: readonly StemKindId[], gains: StemGains, speed: number) =>
  `${speed}|${kinds.map((kind) => (gains[kind] ?? 1).toFixed(3)).join(",")}`;

/**
 * The player: every stem through its own gain at 100 % (mute, solo and volume are instant), a
 * rendered mix at a slower speed, one song clock for both, and the A-B loop and the count-in.
 * It keeps the position in seconds of the song, whatever the speed.
 */
export function createStemPlayer({
  kinds,
  source,
  backend,
  debounceMs = RENDER_DEBOUNCE_MS,
}: {
  kinds: readonly StemKindId[];
  source: StemSource;
  backend: AudioBackend;
  debounceMs?: number;
}): StemPlayer {
  const listeners = new Set<() => void>();
  const clips = new Map<StemKindId, AudioClip>();
  let gains: StemGains = {};
  let mix: Mix | null = null;
  /** The speed the sound plays at now; `state.speed` is the one asked for. */
  let activeSpeed = 100;
  let voices: { voice: AudioVoice; kind: StemKindId | null }[] = [];
  let anchor = { song: 0, clock: 0 };
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let renderToken = 0;
  let countTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let state: StemPlayerState = {
    loaded: false,
    playing: false,
    duration: 0,
    speed: 100,
    loop: null,
    countIn: false,
    countdown: null,
    rendering: false,
    position: 0,
    error: null,
  };

  const emit = (patch: Partial<StemPlayerState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  /** Seconds into the song now. */
  const position = (): number => {
    if (!state.playing) return state.position;
    const rate = activeSpeed / 100;
    let song = anchor.song + (backend.clock() - anchor.clock) * rate;
    const loop = state.loop;
    // A loop only repeats when playback began before its end.
    if (loop && anchor.song < loop.end && song >= loop.end) {
      song = loop.start + ((song - loop.start) % (loop.end - loop.start));
    }
    return Math.min(song, state.duration);
  };

  const stopVoices = () => {
    for (const { voice } of voices) voice.stop();
    voices = [];
  };

  /** Starts the sound at `song` seconds, at the active speed. */
  const startVoices = (song: number) => {
    stopVoices();
    const rate = activeSpeed / 100;
    const loop = state.loop && song < state.loop.end ? state.loop : null;
    const inClip = loop && { start: loop.start / rate, end: loop.end / rate };
    const ended = () => {
      stopVoices();
      emit({ playing: false, position: 0 });
    };
    if (activeSpeed === 100) {
      const longest = kinds.reduce(
        (best, kind) =>
          (clips.get(kind)?.duration ?? 0) > (clips.get(best)?.duration ?? 0) ? kind : best,
        kinds[0]!,
      );
      for (const kind of kinds) {
        const clip = clips.get(kind);
        if (!clip) continue;
        const voice = backend.start(
          clip,
          song,
          gains[kind] ?? 1,
          inClip,
          kind === longest ? ended : () => {},
        );
        voices.push({ voice, kind });
      }
    } else if (mix) {
      voices.push({ voice: backend.start(mix.clip, song / rate, 1, inClip, ended), kind: null });
    }
    anchor = { song, clock: backend.clock() };
  };

  const stopCount = () => {
    if (countTimer !== undefined) clearInterval(countTimer);
    countTimer = undefined;
    if (state.countdown !== null) emit({ countdown: null });
  };

  const begin = () => {
    const from = state.position >= state.duration - 0.05 ? 0 : state.position;
    startVoices(from);
    emit({ playing: true, countdown: null, position: from });
  };

  /** Renders the slowed mix for the speed asked for, then plays it from where the song is. */
  const renderNow = async () => {
    clearTimeout(renderTimer);
    renderTimer = undefined;
    const wanted = state.speed;
    if (wanted === 100) {
      renderToken++;
      emit({ rendering: false });
      return;
    }
    const key = speedKey(kinds, gains, wanted);
    if (mix?.key === key) {
      renderToken++;
      emit({ rendering: false });
      if (activeSpeed !== wanted) activate(mix);
      return;
    }
    const token = ++renderToken;
    emit({ rendering: true, error: null });
    try {
      const bytes = await source.renderMix(gains, wanted / 100);
      const clip = await backend.decode(bytes);
      if (token !== renderToken || disposed) return;
      mix = { key, speed: wanted, clip };
      emit({ rendering: false });
      activate(mix);
    } catch (cause) {
      if (token !== renderToken || disposed) return;
      emit({
        rendering: false,
        // The sound is still at the speed it was; show that.
        speed: activeSpeed,
        error:
          cause instanceof Error
            ? cause.message
            : String((cause as { message?: string })?.message ?? cause),
      });
    }
  };

  /** Switches the sound to a freshly rendered mix, or to the stems at 100 %. */
  const activate = (next: Mix | null) => {
    const song = position();
    activeSpeed = next ? next.speed : 100;
    if (state.playing) {
      startVoices(song);
      emit({ position: song });
    }
  };

  const scheduleRender = () => {
    clearTimeout(renderTimer);
    if (state.speed === 100) return;
    if (mix?.key === speedKey(kinds, gains, state.speed) && activeSpeed === state.speed) {
      renderToken++;
      emit({ rendering: false });
      return;
    }
    emit({ rendering: true });
    renderTimer = setTimeout(() => void renderNow(), debounceMs);
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      try {
        const decoded = await Promise.all(
          kinds.map(
            async (kind) => [kind, await backend.decode(await source.readStem(kind))] as const,
          ),
        );
        if (disposed) return;
        for (const [kind, clip] of decoded) clips.set(kind, clip);
        const duration = Math.max(0, ...decoded.map(([, clip]) => clip.duration));
        emit({ loaded: true, duration, error: null });
      } catch (cause) {
        emit({
          error:
            cause instanceof Error
              ? cause.message
              : String((cause as { message?: string })?.message ?? cause),
        });
      }
    },
    position,
    peaks: (kind, buckets) =>
      clips.get(kind)?.peaks(buckets) ?? Array.from({ length: buckets }, () => 0),
    async play() {
      if (!state.loaded || state.playing || state.countdown !== null) return;
      try {
        // A webview with no audio output may never answer: go on after a moment.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          backend.resume(),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, RESUME_WAIT_MS))),
        ]).finally(() => clearTimeout(timer));
      } catch {
        // The browser refused to start audio; starting the sources then reports nothing.
      }
      if (disposed || state.playing || state.countdown !== null) return;
      if (!state.countIn) {
        begin();
        return;
      }
      const startedAt = Date.now();
      const remaining = () => COUNT_IN_SECONDS - (Date.now() - startedAt) / 1000;
      emit({ countdown: COUNT_IN_SECONDS });
      countTimer = setInterval(() => {
        const left = remaining();
        if (left <= 0) {
          clearInterval(countTimer);
          countTimer = undefined;
          begin();
        } else if (Math.ceil(left) !== state.countdown) {
          emit({ countdown: Math.ceil(left) });
        }
      }, 100);
    },
    pause() {
      stopCount();
      if (!state.playing) return;
      const song = position();
      stopVoices();
      emit({ playing: false, position: song });
    },
    stop() {
      stopCount();
      stopVoices();
      emit({ playing: false, position: state.loop ? state.loop.start : 0 });
    },
    seek(seconds) {
      const song = Math.min(Math.max(0, seconds), state.duration);
      if (state.playing) {
        startVoices(song);
        emit({ position: song });
      } else {
        emit({ position: song });
      }
    },
    setGains(next) {
      gains = next;
      for (const { voice, kind } of voices) {
        if (kind) voice.setGain(next[kind] ?? 1);
      }
      scheduleRender();
    },
    setSpeed(percent) {
      if (!(STEM_SPEEDS as readonly number[]).includes(percent) || percent === state.speed) return;
      emit({ speed: percent, error: null });
      if (percent === 100) {
        renderToken++;
        clearTimeout(renderTimer);
        emit({ rendering: false });
        activate(null);
      } else {
        void renderNow();
      }
    },
    setLoop(loop) {
      let next: StemLoop | null = null;
      if (loop) {
        const start = Math.max(0, Math.min(loop.start, loop.end));
        const end = Math.min(state.duration, Math.max(loop.start, loop.end));
        if (end - start < MIN_LOOP_SECONDS) return;
        next = { start, end };
      }
      const song = position();
      emit({ loop: next });
      // The playing sound repeats from its own settings: start it again from here.
      if (state.playing) startVoices(song);
    },
    setCountIn(on) {
      emit({ countIn: on });
    },
    dispose() {
      if (disposed) return;
      stopCount();
      stopVoices();
      clearTimeout(renderTimer);
      renderToken++;
      disposed = true;
      listeners.clear();
      backend.close();
    },
  };
}
