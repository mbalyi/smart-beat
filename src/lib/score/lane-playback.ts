import type { midi } from "@coderline/alphatab";

import { LaneFollower } from "@/lib/audio/lane-follower";
import {
  NativeEngine,
  clockSongFromMidi,
  type EffectProblems,
  type EngineExtras,
} from "@/lib/audio/native-engine";
import { tempoMap, tickToMs, type TempoMap } from "@/lib/audio/tempo-map";
import { SOUNDFONTS } from "@/lib/score/soundfonts";
import { engineState, type SourceInfo, type SourceLocation } from "@/lib/tauri";

export interface LanePlaybackOptions {
  /** How long after the notes player renders something it is heard (ms). */
  synthLatencyMs: () => number;
  /** Downloads the bytes of the SoundFont the engine opens with. */
  fetchSoundFont: (url: string) => Promise<Uint8Array>;
  onError: (error: Error) => void;
}

/**
 * Audio lanes next to notes that the SoundFonts synthesizer plays (hybrid playback, ADR 0003):
 * the native engine runs with only the lanes (a song with the tempo map and no tracks) and a
 * {@link LaneFollower} keeps it in time with alphaTab's transport. The notes' player tells this
 * class what it does; it never plays or pauses the notes itself.
 */
export class LanePlayback {
  private readonly engine: NativeEngine;
  private readonly follower: LaneFollower;
  private tempo: TempoMap | null = null;
  private starting: Promise<void> | null = null;
  private destroyed = false;
  /** The lanes engine has the song and what it plays: from the last MIDI load. */
  private loaded = false;
  /** The last MIDI: the song the engine gets when the first lane is added. */
  private file: midi.MidiFile | null = null;

  private readonly options: LanePlaybackOptions;

  constructor(options: LanePlaybackOptions) {
    this.options = options;
    this.engine = new NativeEngine({
      onStatus: (status) => this.follower.onStatus(status),
      onError: (error) => options.onError(error),
    });
    this.follower = new LaneFollower(this.engine, { synthLatencyMs: options.synthLatencyMs });
  }

  /** Opens the engine (the output) if no tab has, with the small SoundFont that ships with the app. */
  private start(): Promise<void> {
    this.starting ??= (async () => {
      const running = await this.engine.clock();
      if (running) return;
      const font = SOUNDFONTS.find((f) => f.id === "sonivox") ?? SOUNDFONTS[0]!;
      await this.engine.useSoundFont(font.id, await this.options.fetchSoundFont(font.url));
    })().catch((error: unknown) => {
      this.starting = null;
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return this.starting;
  }

  /** Opens an audio file for the lanes. */
  async loadSource(location: SourceLocation): Promise<SourceInfo> {
    await this.start();
    return this.engine.loadSource(location);
  }

  /** The score was generated (again): the lanes engine gets its tempo map, then the lanes. */
  async load(file: midi.MidiFile, extras: EngineExtras): Promise<void> {
    this.file = file;
    const song = clockSongFromMidi(file);
    this.tempo = tempoMap(song.division, song.tempos);
    this.engine.prepare(extras);
    // An engine that nobody plays lanes with is not opened for nothing.
    if (!extras.lanes && !this.loaded && !this.starting) return;
    await this.start();
    if (this.destroyed) return;
    await this.engine.loadSong(file, [], true);
    this.loaded = true;
    await this.follower.calibrate();
  }

  /** The lanes changed (or the mix did): only what changed is sent. */
  async configure(extras: EngineExtras): Promise<EffectProblems | null> {
    if (this.destroyed) return null;
    this.engine.prepare(extras);
    if (!this.loaded) {
      // The first lane of the song: the engine opens now.
      if (extras.lanes && this.file) await this.load(this.file, extras);
      return null;
    }
    return this.engine.configure(extras);
  }

  /** What a tick of the notes is in song time (ms). */
  private ms(tick: number): number {
    return this.tempo ? tickToMs(this.tempo, tick) : 0;
  }

  /** The notes start playing at `tick`. */
  play(tick: number, speed: number) {
    if (!this.loaded) return;
    this.follower.start(this.ms(tick), speed);
  }

  pause() {
    if (this.loaded) this.follower.pause();
  }

  /** The notes are at `tick`: the lanes follow while playing, and go there while paused. */
  position(tick: number, playing: boolean) {
    if (!this.loaded) return;
    if (playing) this.follower.follow(this.ms(tick));
    else this.follower.seek(this.ms(tick));
  }

  setSpeed(speed: number) {
    if (this.loaded) this.follower.setSpeed(speed);
  }

  setMasterVolume(volume: number) {
    this.engine.masterVolume = volume;
  }

  setLoop(range: { startTick: number; endTick: number } | null) {
    this.engine.setLoop(range, null);
  }

  /** Whether the engine runs (another tab may have opened it). */
  async running(): Promise<boolean> {
    return (await engineState().catch(() => null))?.running ?? false;
  }

  destroy() {
    this.destroyed = true;
    this.engine.destroy();
  }
}
