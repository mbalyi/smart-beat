/**
 * The native audio engine (Rust, `src-tauri/src/audio`, ADR 0002) as alphaTab
 * sees it: an external media source. alphaTab keeps the notation, the cursor
 * and the transport buttons; this class sends the MIDI alphaTab generates to
 * the engine, forwards play / pause / seek / speed, and reports the engine's
 * position back so the cursor follows what is heard.
 */
import { midi, type synth } from "@coderline/alphatab";

import type { EffectSlot } from "@/lib/audio/effects";
import type { Score } from "@/lib/score/score";
import {
  engineState,
  engineTransport,
  loadEngineSong,
  loadEngineSoundFont,
  setEngineChain,
  setEngineMix,
  startEngine,
  type BlockProblem,
  type BusMix,
  type EngineMeters,
  type EngineSong,
  type EngineStatus,
  type TransportCommand,
} from "@/lib/tauri";

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
  onError?: (error: Error) => void;
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
  /** The chains to (re)send with every song: track index → chain, -1 = master. */
  private chains = new Map<number, EffectSlot[]>();

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
    this.send({ type: "rate", value });
  }

  get masterVolume() {
    return this.volume;
  }

  set masterVolume(value: number) {
    this.volume = value;
    this.send({ type: "masterVolume", value });
  }

  seekTo(time: number) {
    this.send({ type: "seek", ms: Math.max(0, time) });
    // Report it at once: the cursor should move even while paused.
    this.output?.updatePosition(Math.max(0, time));
  }

  play() {
    this.send({ type: "play" });
    this.startPolling();
  }

  pause() {
    this.send({ type: "pause" });
    this.stopPolling();
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
    const song = songFromMidi(file, channels);
    const status = await this.enqueue(async () => {
      await loadEngineSong(song);
      // Loading a song clears the engine's chains: send them again.
      for (const [track, slots] of this.chains) {
        await setEngineChain(track < 0 ? null : track, slots);
      }
      return engineState();
    });
    this.backingTrackDuration = status.durationMs;
  }

  setMix(mixes: BusMix[]) {
    this.enqueue(() => setEngineMix(mixes)).catch((error) =>
      this.callbacks.onError?.(asError(error)),
    );
  }

  setLoop(range: { startTick: number; endTick: number } | null) {
    this.send({
      type: "loop",
      startTick: range?.startTick ?? null,
      endTick: range?.endTick ?? null,
    });
  }

  setMetronome(volume: number) {
    this.send({ type: "metronome", volume });
  }

  setChain(track: number | null, slots: EffectSlot[]): Promise<BlockProblem[]> {
    this.chains.set(track ?? -1, slots);
    return this.enqueue(() => setEngineChain(track, slots));
  }

  /**
   * Replaces every chain (after tracks were added, removed or moved). Resolves
   * to the problems of each track's chain and of the master's.
   */
  async setAllChains(
    tracks: readonly EffectSlot[][],
    master: EffectSlot[],
  ): Promise<{ tracks: BlockProblem[][]; master: BlockProblem[] }> {
    this.chains = new Map(tracks.map((slots, i) => [i, slots]));
    this.chains.set(-1, master);
    return this.enqueue(async () => {
      const problems: BlockProblem[][] = [];
      for (const [i, slots] of tracks.entries()) problems.push(await setEngineChain(i, slots));
      return { tracks: problems, master: await setEngineChain(null, master) };
    });
  }

  private startPolling() {
    if (this.polling || this.destroyed) return;
    let wasPlaying = false;
    this.polling = setInterval(() => {
      engineState()
        .then((status) => {
          if (this.destroyed) return;
          this.output?.updatePosition(status.positionMs);
          this.callbacks.onMeters?.(status.meters);
          this.callbacks.onStatus?.(status);
          // The engine stopped by itself at the end of the song.
          if (wasPlaying && !status.playing) this.stopPolling();
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
    this.stopPolling();
    engineTransport({ type: "pause" }).catch(() => {});
    if (this.output?.handler === this) this.output.handler = undefined;
    this.output = null;
  }
}

/** The bus mixes for the engine from the app's mixer settings. */
export function busMixes(mix: {
  tracks: { volume: number; mute: boolean; solo: boolean }[];
}): BusMix[] {
  // Pan is written into the MIDI (as for alphaTab's synthesizer), so the
  // engine's own pan stays centred.
  return mix.tracks.map((t) => ({ volume: t.volume, pan: 0, mute: t.mute, solo: t.solo }));
}
