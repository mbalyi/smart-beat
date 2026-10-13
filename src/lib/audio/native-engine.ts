/**
 * The native audio engine (Rust, `src-tauri/src/audio`, ADR 0003) as alphaTab
 * sees it: an external media source. alphaTab keeps the notation, the cursor
 * and the transport buttons; this class sends the MIDI alphaTab generates to
 * the engine, forwards play / pause / seek / speed, and reports the engine's
 * position back so the cursor follows what is heard.
 */
import { midi, type synth } from "@coderline/alphatab";

import type { EffectSlot } from "@/lib/audio/effects";
import type { Score } from "@/lib/score/score";
import {
  clearEngineBacking,
  engineState,
  engineTransport,
  loadEngineBacking,
  loadEngineSong,
  loadEngineSoundFont,
  setEngineAutomation,
  setEngineBacking,
  setEngineChain,
  setEngineDrumMix,
  setEngineMix,
  setEngineMonitor,
  setEngineMonitorChain,
  setEngineSounds,
  setEngineTrackEq,
  startEngine,
  type BackingInfo,
  type BackingParams,
  type BackingSource,
  type BlockProblem,
  type BusMix,
  type EngineAutomation,
  type EngineDrumMix,
  type EngineMeters,
  type EngineSong,
  type EngineStatus,
  type MonitorParams,
  type MonitorStatus,
  type TrackEq,
  type TransportCommand,
  setEngineTrackKit,
} from "@/lib/tauri";

/** A track's sounds as the engine plays them: a chain each, and `[tick, sound]` switches. */
export interface EngineTrackSounds {
  chains: EffectSlot[][];
  switches: [number, number][];
}

/** The audio input the monitor track plays: its name (null: the system's default), and channel. */
export interface MonitorInputChoice {
  device: string | null;
  /** 0-based; null: all channels mixed. */
  channel: number | null;
}

/** The monitor track as the engine plays it (null: none). */
export type EngineMonitor =
  ({ params: MonitorParams; effects: EffectSlot[] } & MonitorInputChoice) | null;

/** Everything the engine plays besides the notes. Sent again after every song load. */
export interface EngineExtras {
  sounds: EngineTrackSounds[];
  master: EffectSlot[];
  automation: EngineAutomation[];
  eq: TrackEq[];
  drums: (EngineDrumMix | null)[];
  /** The imported drum kit of each track (#40; null: the SoundFont's kit). */
  kits?: (string | null)[];
  masterPan: number;
  /** Audio track settings and sync points (null: none loaded). */
  backing: { params: BackingParams; sync: { tick: number; ms: number }[] } | null;
  /** The monitor track (missing or null: none). */
  monitor?: EngineMonitor;
}

/** Blocks that cannot run: per track and sound, the master's and the monitor track's. */
export interface EffectProblems {
  tracks: BlockProblem[][][];
  master: BlockProblem[];
  monitor?: BlockProblem[];
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** The monitor track without its effects (they are sent on their own). */
const monitorSettings = (m: EngineMonitor) =>
  m && { params: m.params, device: m.device, channel: m.channel };
const EMPTY_AUTOMATION: EngineAutomation = { enabled: false, volume: [], pan: [], mute: [] };
const FLAT: TrackEq = { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 };

const {
  AlphaTabMetronomeEvent,
  ControlChangeEvent,
  NoteBendEvent,
  NoteOffEvent,
  NoteOnEvent,
  PitchBendEvent,
  ProgramChangeEvent,
  TempoChangeEvent,
} = midi;

/**
 * The Rust engine is one per app, but every open song has its own
 * `NativeEngine`. The one that loaded its song last owns the engine; another
 * one takes it over (loads its song again) before it plays.
 */
let owner: NativeEngine | null = null;

/** For tests: no song owns the engine. */
export const forgetEngineOwner = () => {
  owner = null;
};
const takeEngine = (engine: NativeEngine) => {
  owner = engine;
};

/** Loads slower than this are logged (ms). */
const SLOW_MS = 300;

/** How often the position is read while playing (ms). */
export const POLL_MS = 25;

/** Every MIDI channel the tracks of a score play on, in score order. */
export function trackChannels(score: Score): number[][] {
  return score.tracks.map((track) => {
    const { primaryChannel, secondaryChannel } = track.playbackInfo;
    return [...new Set([primaryChannel, secondaryChannel])].filter((c) => c >= 0 && c < 16);
  });
}

const byte = (value: number) => Math.min(127, Math.max(0, Math.round(value)));

/**
 * The song the engine plays: alphaTab's generated MIDI as plain numbers.
 * Per-note pitch bends become channel bends (one bending note per channel is
 * by far the common case on guitar).
 */
export function songFromMidi(file: midi.MidiFile, channels: number[][]): EngineSong {
  const song: EngineSong = {
    division: file.division,
    events: [],
    tempos: [],
    metronome: [],
    tracks: channels,
    endTick: 0,
  };
  for (const event of file.events) {
    const tick = event.tick;
    song.endTick = Math.max(song.endTick, tick);
    if (event instanceof NoteOnEvent) {
      song.events.push([tick, 0x90 | event.channel, byte(event.noteKey), byte(event.noteVelocity)]);
    } else if (event instanceof NoteOffEvent) {
      song.events.push([tick, 0x80 | event.channel, byte(event.noteKey), 0]);
    } else if (event instanceof ControlChangeEvent) {
      song.events.push([tick, 0xb0 | event.channel, byte(event.controller), byte(event.value)]);
    } else if (event instanceof ProgramChangeEvent) {
      song.events.push([tick, 0xc0 | event.channel, byte(event.program), 0]);
    } else if (event instanceof PitchBendEvent || event instanceof NoteBendEvent) {
      const value = Math.min(16383, Math.max(0, Math.round(event.value)));
      song.events.push([tick, 0xe0 | event.channel, value & 0x7f, value >> 7]);
    } else if (event instanceof TempoChangeEvent) {
      song.tempos.push([tick, event.beatsPerMinute]);
    } else if (event instanceof AlphaTabMetronomeEvent) {
      song.metronome.push([tick, event.metronomeNumerator === 0]);
    }
  }
  return song;
}

export interface NativeEngineCallbacks {
  onMeters?: (meters: EngineMeters) => void;
  onStatus?: (status: EngineStatus) => void;
  /** A sound crashed in the audio callback: the engine switched every effect off and stopped. */
  onFault?: () => void;
  onError?: (error: Error) => void;
  /** Loops played to the end (the engine starts them again by itself; #83). */
  onLoops?: (count: number) => void;
  /** The monitor track's input opened, closed or failed (null: no monitor track). */
  onMonitorStatus?: (status: MonitorStatus | null) => void;
}

const asError = (error: unknown) =>
  error instanceof Error
    ? error
    : new Error(
        typeof error === "object" && error && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error),
      );

export class NativeEngine implements synth.IExternalMediaHandler {
  backingTrackDuration = 0;
  private rate = 1;
  private volume = 1;
  private output: synth.IExternalMediaSynthOutput | null = null;
  private polling: ReturnType<typeof setInterval> | null = null;
  private soundFontId: string | null = null;
  private destroyed = false;
  private readonly callbacks: NativeEngineCallbacks;
  /**
   * Requests run one after another: some engine commands run on other
   * threads, and a Play must never overtake the song it plays.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** What the engine should have, and what it was last sent (null: nothing yet). */
  private desired: EngineExtras | null = null;
  private sent: EngineExtras | null = null;
  private problems: EffectProblems = { tracks: [], master: [] };
  /** What this song put in the engine, to put it back after another song used it. */
  private song: EngineSong | null = null;
  /** The newest song handed to {@link loadSong} (older ones still queued are skipped). */
  private latestSong: EngineSong | null = null;
  private mixes: BusMix[] | null = null;
  private loop: { startTick: number; endTick: number } | null = null;
  private metronomeVolume: number | null = null;
  private backing: BackingSource | null = null;
  /** The monitor track listens: the engine is read while paused too (its level meter). */
  private monitoring = false;
  /** Play was asked for, and the song has not stopped since. */
  private playRequested = false;
  /** The monitor status last reported (to report changes only). */
  private monitorStatus: string | null = null;
  /**
   * The monitor track the engine has from this song (undefined: unknown, after another song
   * used the engine). Loading a song keeps it, so edits do not reopen the input.
   */
  private monitorSent: EngineMonitor | undefined = undefined;

  /**
   * The clicks to play before the song when it starts (null: none). The engine
   * counts them in real time and starts the song right after the last one.
   */
  countIn: (() => { beats: number; beatSeconds: number } | null) | null = null;

  constructor(callbacks: NativeEngineCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Connects to alphaTab's external media output (the player in external-media mode). */
  attach(output: synth.IExternalMediaSynthOutput) {
    this.output = output;
    output.handler = this;
  }

  private enqueue<T>(request: () => Promise<T>): Promise<T> {
    const next = this.queue.then(request, request);
    this.queue = next.catch(() => {});
    return next;
  }

  private send(command: TransportCommand) {
    this.enqueue(() => engineTransport(command)).catch((error) =>
      this.callbacks.onError?.(asError(error)),
    );
  }

  get playbackRate() {
    return this.rate;
  }

  set playbackRate(value: number) {
    this.rate = value;
    if (this.ownsOrFree) this.send({ type: "rate", value });
  }

  get masterVolume() {
    return this.volume;
  }

  set masterVolume(value: number) {
    this.volume = value;
    if (this.ownsOrFree) this.send({ type: "masterVolume", value });
  }

  seekTo(time: number) {
    this.claim();
    this.send({ type: "seek", ms: Math.max(0, time) });
    // Report it at once: the cursor should move even while paused.
    this.output?.updatePosition(Math.max(0, time));
  }

  /**
   * Makes sure the engine holds this song, not the one of another tab (which
   * would play the wrong music, or nothing).
   */
  private get ownsOrFree() {
    return owner === null || owner === this;
  }

  private claim() {
    if (owner === this || !this.song) return;
    takeEngine(this);
    const song = this.song;
    this.enqueue(async () => {
      await loadEngineSong(song);
      this.sent = null;
      // The engine has the other song's monitor track.
      this.monitorSent = undefined;
      if (this.backing) await loadEngineBacking(this.backing);
      else await clearEngineBacking();
      await this.sendExtras();
      await engineTransport({ type: "rate", value: this.rate });
      await engineTransport({ type: "masterVolume", value: this.volume });
      if (this.mixes) await setEngineMix(this.mixes);
      await engineTransport({
        type: "loop",
        startTick: this.loop?.startTick ?? null,
        endTick: this.loop?.endTick ?? null,
        countIn: this.loopCountIn,
      });
      if (this.metronomeVolume !== null) {
        await engineTransport({ type: "metronome", volume: this.metronomeVolume });
      }
    }).catch((error) => this.callbacks.onError?.(asError(error)));
  }

  play() {
    this.playRequested = true;
    this.claim();
    const clicks = this.countIn?.();
    this.send(
      clicks
        ? { type: "countIn", beats: clicks.beats, beatSeconds: clicks.beatSeconds / this.rate }
        : { type: "play" },
    );
    this.startPolling();
  }

  pause() {
    // A song in a hidden tab must not pause the one that is playing.
    if (this.ownsOrFree) this.send({ type: "pause" });
    this.playRequested = false;
    if (!this.monitoring) this.stopPolling();
  }

  /** Loads (once) and switches to a SoundFont, opening the audio output. */
  async useSoundFont(id: string, bytes: Uint8Array): Promise<EngineStatus> {
    const status = await this.enqueue(async () => {
      await loadEngineSoundFont(id, bytes);
      return startEngine(id);
    });
    this.soundFontId = id;
    return status;
  }

  get soundFont(): string | null {
    return this.soundFontId;
  }

  async loadSong(file: midi.MidiFile, channels: number[][]): Promise<void> {
    const started = performance.now();
    const song = songFromMidi(file, channels);
    this.song = song;
    // Another song had the engine: it has that song's monitor track.
    if (owner !== this) this.monitorSent = undefined;
    takeEngine(this);
    this.latestSong = song;
    const status = await this.enqueue(async () => {
      // While typing, every edit sends a song: only the newest one is loaded.
      if (this.latestSong !== song) return null;
      await loadEngineSong(song);
      // Loading a song clears the engine's chains, sounds, automation, EQ and
      // drum mixes: send them all again.
      this.sent = null;
      await this.sendExtras();
      return engineState();
    });
    if (status) this.backingTrackDuration = status.durationMs;
    const took = performance.now() - started;
    if (took > SLOW_MS) {
      console.info(`[perf] song load took ${Math.round(took)} ms (${song.events.length} events)`);
    }
  }

  /** What to send with the next song (without sending anything now). */
  prepare(extras: EngineExtras) {
    this.desired = extras;
  }

  /**
   * Sets everything besides the notes; only what changed since the last call
   * is sent (a knob turn updates one block). Resolves to the blocks that
   * cannot run.
   */
  configure(extras: EngineExtras): Promise<EffectProblems> {
    this.desired = extras;
    return this.enqueue(() => this.sendExtras());
  }

  private async sendExtras(): Promise<EffectProblems> {
    const next = this.desired;
    if (!next) return this.problems;
    const prev = this.sent;
    const problems: EffectProblems = {
      tracks: next.sounds.map((_, i) => this.problems.tracks[i] ?? []),
      master: this.problems.master,
      monitor: next.monitor ? (this.problems.monitor ?? []) : [],
    };
    for (const [i, sounds] of next.sounds.entries()) {
      const before = prev?.sounds[i];
      if (before && same(before, sounds)) continue;
      const oneSound = sounds.chains.length === 1 && sounds.switches.length === 0;
      const wasOne = !before || (before.chains.length === 1 && before.switches.length === 0);
      if (oneSound && wasOne) {
        problems.tracks[i] = [await setEngineChain(i, sounds.chains[0] ?? [])];
      } else if (
        before &&
        before.chains.length === sounds.chains.length &&
        same(before.switches, sounds.switches)
      ) {
        // The same sounds: send only the chains that changed (live knob updates).
        const list = [...(problems.tracks[i] ?? [])];
        for (const [sound, chain] of sounds.chains.entries()) {
          if (!same(before.chains[sound], chain))
            list[sound] = await setEngineChain(i, chain, sound);
        }
        problems.tracks[i] = list;
      } else {
        problems.tracks[i] = await setEngineSounds(i, sounds.chains, sounds.switches);
      }
    }
    if (!prev || !same(prev.master, next.master)) {
      problems.master = await setEngineChain(null, next.master);
    }
    for (const [i, automation] of next.automation.entries()) {
      const before = prev?.automation[i] ?? EMPTY_AUTOMATION;
      if (!same(before, automation)) await setEngineAutomation(i, automation);
    }
    for (const [i, eq] of next.eq.entries()) {
      const before = prev?.eq[i] ?? FLAT;
      if (!same(before, eq)) await setEngineTrackEq(i, eq);
    }
    // Kits first: a drum mixer is built for the kit the track plays.
    for (const [i, kit] of (next.kits ?? []).entries()) {
      const before = prev?.kits?.[i] ?? null;
      if (before !== kit) await setEngineTrackKit(i, kit);
    }
    for (const [i, drums] of next.drums.entries()) {
      const before = prev?.drums[i] ?? null;
      if (!same(before, drums)) await setEngineDrumMix(i, drums);
    }
    if ((prev?.masterPan ?? 0) !== next.masterPan) {
      await engineTransport({ type: "masterPan", value: next.masterPan });
    }
    if (next.backing && !same(prev?.backing ?? null, next.backing)) {
      await setEngineBacking(next.backing.params, next.backing.sync);
    }
    // Loading a song keeps the monitor track (and its open input): sent only when it changed.
    const monitor = next.monitor ?? null;
    const before = this.monitorSent;
    if (before === undefined || !same(monitorSettings(before), monitorSettings(monitor))) {
      this.reportMonitor(await setEngineMonitor(monitorSettings(monitor)));
    }
    if (monitor && (!before || !same(before.effects, monitor.effects))) {
      problems.monitor = await setEngineMonitorChain(monitor.effects);
    }
    this.monitorSent = monitor;
    this.setMonitoring(!!monitor?.params.enabled);
    this.sent = next;
    this.problems = problems;
    return problems;
  }

  /** Opens a recording as the audio track; its settings follow with {@link configure}. */
  loadBacking(source: BackingSource): Promise<BackingInfo> {
    this.backing = source;
    return this.enqueue(async () => {
      const info = await loadEngineBacking(source);
      // The engine starts it with default settings: send ours again.
      if (this.sent) this.sent = { ...this.sent, backing: null };
      await this.sendExtras();
      return info;
    });
  }

  clearBacking(): Promise<void> {
    this.backing = null;
    return this.enqueue(async () => {
      await clearEngineBacking();
      if (this.sent) this.sent = { ...this.sent, backing: null };
    });
  }

  /** Tells the app about the monitor track's input when it changes. */
  private reportMonitor(status: MonitorStatus | null | undefined) {
    const key = JSON.stringify(status ?? null);
    if (key === this.monitorStatus) return;
    this.monitorStatus = key;
    this.callbacks.onMonitorStatus?.(status ?? null);
  }

  /** While the monitor track listens, its level is read even when the song is paused. */
  private setMonitoring(on: boolean) {
    if (on === this.monitoring) return;
    this.monitoring = on;
    if (on) this.startPolling();
    else if (!this.playRequested) this.stopPolling();
  }

  setMix(mixes: BusMix[]) {
    this.mixes = mixes;
    if (!this.ownsOrFree) return;
    this.enqueue(() => setEngineMix(mixes)).catch((error) =>
      this.callbacks.onError?.(asError(error)),
    );
  }

  /** Loops between two ticks (null: no loop), with `countIn` clicks before every loop (#83). */
  setLoop(
    range: { startTick: number; endTick: number } | null,
    countIn: { beats: number; beatSeconds: number } | null = null,
  ) {
    this.loop = range;
    this.loopCountIn = range ? countIn : null;
    if (!this.ownsOrFree) return;
    this.send({
      type: "loop",
      startTick: range?.startTick ?? null,
      endTick: range?.endTick ?? null,
      countIn: this.loopCountIn,
    });
  }
  private loopCountIn: { beats: number; beatSeconds: number } | null = null;

  /** Plays one note now (a drum picked in the kit; with `program`, that instrument). */
  preview(channel: number, key: number, velocity = 100, program?: number) {
    this.claim();
    this.send({
      type: "preview",
      channel,
      key,
      velocity,
      ...(program !== undefined && { program }),
    });
  }

  /** Ends the previewed notes of a channel. */
  previewStop(channel: number) {
    this.send({ type: "previewStop", channel });
  }

  setMetronome(volume: number) {
    this.metronomeVolume = volume;
    if (!this.ownsOrFree) return;
    this.send({ type: "metronome", volume });
  }

  private startPolling() {
    if (this.polling || this.destroyed) return;
    let wasPlaying = false;
    this.polling = setInterval(() => {
      engineState()
        .then((status) => {
          if (this.destroyed) return;
          // While paused (the monitor track listening) the cursor is the app's: a seek waiting
          // in the queue must not be undone by an older position.
          if (status.playing || wasPlaying) this.output?.updatePosition(status.positionMs);
          this.callbacks.onMeters?.(status.meters);
          this.callbacks.onStatus?.(status);
          if (status.monitor !== undefined && this.ownsOrFree) this.reportMonitor(status.monitor);
          if (status.faults > 0) this.callbacks.onFault?.();
          if (status.loops > 0) this.callbacks.onLoops?.(status.loops);
          // The engine stopped by itself at the end of the song.
          if (wasPlaying && !status.playing) {
            this.playRequested = false;
            if (!this.monitoring) this.stopPolling();
          }
          wasPlaying = status.playing;
        })
        .catch((error) => {
          this.stopPolling();
          this.callbacks.onError?.(asError(error));
        });
    }, POLL_MS);
  }

  private stopPolling() {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
  }

  destroy() {
    this.destroyed = true;
    const wasOwner = owner === this;
    if (wasOwner) owner = null;
    this.stopPolling();
    if (wasOwner) engineTransport({ type: "pause" }).catch(() => {});
    // A closed song's monitor track stops listening.
    if (wasOwner && this.monitorSent) setEngineMonitor(null).catch(() => {});
    if (this.output?.handler === this) this.output.handler = undefined;
    this.output = null;
  }
}

/** The bus mixes for the engine from the app's mixer settings. */
export function busMixes(
  mix: { tracks: { volume: number; mute: boolean; solo: boolean }[] },
  trims: readonly number[] = [],
): BusMix[] {
  // Pan is written into the MIDI (as for alphaTab's synthesizer), so the
  // engine's own pan stays centred (pan automation moves it).
  return mix.tracks.map((t, i) => ({
    volume: t.volume,
    pan: 0,
    mute: t.mute,
    solo: t.solo,
    trimDb: trims[i] ?? 0,
  }));
}
