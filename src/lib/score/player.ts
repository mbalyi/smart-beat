/**
 * Adapter between the UI and alphaTab: renders a score into an element and
 * plays it with a SoundFont. Components talk to this class only, so they can
 * be tested without alphaTab (which needs a real browser to render and play).
 */
import {
  AlphaTabApi,
  LayoutMode,
  LogLevel,
  PlayerMode,
  PlayerOutputMode,
  ScrollMode,
  Settings,
  StaveProfile,
  synth,
  TabRhythmMode,
} from "@coderline/alphatab";

import { applyTrackView, gpFromPan, type Score, type TrackView } from "@/lib/score/score";
import type { MixerSettings } from "@/lib/tauri";

const { PlayerState } = synth;

export type Layout = "page" | "horizontal";

export interface PlaybackPosition {
  currentMs: number;
  endMs: number;
  /** Tempo at the current position (follows tempo changes in the score). */
  bpm: number;
}

export interface ScorePlayerCallbacks {
  onRenderingChange?: (rendering: boolean) => void;
  /** Playback is possible (SoundFont and song loaded). */
  onReadyChange?: (ready: boolean) => void;
  onPlayingChange?: (playing: boolean) => void;
  onPositionChange?: (position: PlaybackPosition) => void;
  /** Index of the bar being played (or clicked). */
  onBarChange?: (barIndex: number) => void;
  /**
   * Instrument sounds failed to load. `previousKept`: the sounds in use before
   * the switch still play (the download failed), so nothing needs reloading.
   */
  onSoundFontError?: (error: Error, details: { previousKept: boolean }) => void;
  onError?: (error: Error) => void;
}

export interface ScorePlayerOptions {
  /** Where the notation is drawn. */
  element: HTMLElement;
  /** Scrolled to keep the cursor in view. */
  scrollElement: HTMLElement;
  score: Score;
  trackIndex: number;
  view: TrackView;
  layout: Layout;
  mix: MixerSettings;
  soundFontUrl: string;
  reducedMotion?: boolean;
}

const LAYOUT_MODES: Record<Layout, LayoutMode> = {
  page: LayoutMode.Page,
  horizontal: LayoutMode.Horizontal,
};

const rhythmMode = (view: TrackView) =>
  view.rhythm ? TabRhythmMode.ShowWithBars : TabRhythmMode.Hidden;

async function downloadSoundFont(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The instrument sounds could not be downloaded (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function createSettings(options: ScorePlayerOptions): Settings {
  const base = import.meta.env.BASE_URL;
  const settings = new Settings();
  settings.core.fontDirectory = `${base}font/`;
  settings.core.logLevel = LogLevel.Warning;
  settings.display.layoutMode = LAYOUT_MODES[options.layout];
  settings.display.staveProfile = StaveProfile.Default; // per-staff flags decide
  settings.notation.rhythmMode = rhythmMode(options.view);
  settings.player.playerMode = PlayerMode.EnabledSynthesizer;
  // Synthesize in a worker and play through an AudioWorklet, off the main
  // thread, with alphaTab's default 500 ms buffer, so rendering, scrolling or
  // UI updates can't make the audio stutter.
  settings.player.outputMode = PlayerOutputMode.WebAudioAudioWorklets;
  settings.player.bufferTimeInMilliseconds = 500;
  // Loaded by ScorePlayer.setSoundFont (see there), not by alphaTab.
  settings.player.soundFont = null;
  settings.player.scrollElement = options.scrollElement;
  settings.player.scrollMode = ScrollMode.Continuous;
  settings.player.enableCursor = true;
  settings.player.enableAnimatedBeatCursor = !options.reducedMotion;
  settings.player.nativeBrowserSmoothScroll = !options.reducedMotion;
  // Clicking a beat moves the playback cursor there ("start from here").
  settings.player.enableUserInteraction = true;
  return settings;
}

export class ScorePlayer {
  private readonly api: AlphaTabApi;
  private readonly score: Score;
  private readonly callbacks: ScorePlayerCallbacks;
  private trackIndex: number;
  private mix: MixerSettings;
  private ready = false;
  private playing = false;
  private destroyed = false;
  private lastPosition: PlaybackPosition | null = null;
  private lastBar = -1;
  /** Where (and whether) to continue once a new SoundFont is loaded. */
  private resume: { tick: number; play: boolean } | null = null;
  /** Increases with every SoundFont request, so only the latest one is loaded. */
  private soundFontRequest = 0;
  /** Pan changed during playback: applied at the next pause, never mid-song. */
  private panPending = false;
  /** A SoundFont is loaded in the synthesizer (none right after a reset). */
  private hasSounds = false;
  private readonly synthReady: Promise<void>;
  private readonly soundFontErrors = new WeakSet<Error>();

  constructor(options: ScorePlayerOptions, callbacks: ScorePlayerCallbacks = {}) {
    this.score = options.score;
    this.trackIndex = options.trackIndex;
    this.mix = options.mix;
    this.callbacks = callbacks;

    // Pan is part of the generated MIDI, so it must be in the model before playback.
    this.applyPans(options.mix);
    this.applyView(options.view);

    this.api = new AlphaTabApi(options.element, createSettings(options));
    // alphaTab ignores SoundFonts sent before its synthesizer is ready.
    this.synthReady = new Promise((resolve) => this.api.player?.ready.on(() => resolve()));
    this.subscribe();
    this.api.renderScore(this.score, [this.trackIndex]);
    void this.setSoundFont(options.soundFontUrl);
  }

  private subscribe() {
    const { api, callbacks } = this;
    api.renderStarted.on(() => callbacks.onRenderingChange?.(true));
    api.renderFinished.on(() => callbacks.onRenderingChange?.(false));
    api.playerStateChanged.on((e) => {
      this.playing = e.state === PlayerState.Playing;
      callbacks.onPlayingChange?.(this.playing);
      if (!this.playing && this.panPending) {
        this.panPending = false;
        this.reloadMidi();
      }
    });
    // Also fires when a MIDI file is loaded (with the song length). Don't use
    // `midiLoaded`: in alphaTab 1.8.4 subscribing to it once the worker synth
    // exists recurses forever (AlphaSynthWebWorkerApi.loadedMidiInfo).
    api.playerPositionChanged.on((e) =>
      this.reportPosition(e.currentTime, e.endTime, e.modifiedTempo || e.originalTempo),
    );
    api.playedBeatChanged.on((beat) => this.reportBar(beat.voice.bar.index));
    // playedBeatChanged only fires during playback; a click moves the cursor while paused too.
    api.beatMouseDown.on((beat) => this.reportBar(beat.voice.bar.index));
    // alphaTab reports SoundFont failures through `error` too: report them once.
    api.error.on((error) => {
      queueMicrotask(() => {
        if (!this.soundFontErrors.has(error)) callbacks.onError?.(error);
      });
    });

    const player = api.player;
    if (!player) return;
    // alphaTab resets the channel volumes of the shown track when playback
    // becomes ready. This handler is registered after alphaTab's own, so the
    // mixer is applied last. It also runs again after every MIDI or SoundFont reload.
    player.readyForPlayback.on(() => {
      this.hasSounds = true;
      this.applyMix(null, this.mix);
      const resume = this.resume;
      this.resume = null;
      if (resume) api.tickPosition = resume.tick;
      this.setReady(true);
      if (resume?.play) api.play();
    });
    player.soundFontLoadFailed.on((error) => {
      this.soundFontErrors.add(error);
      callbacks.onSoundFontError?.(error, { previousKept: false });
    });
  }

  private setReady(ready: boolean) {
    if (this.ready === ready) return;
    this.ready = ready;
    this.callbacks.onReadyChange?.(ready);
  }

  private reportPosition(currentMs: number, endMs: number, bpm: number) {
    // While new sounds load alphaTab reports position 0; the real one comes back after.
    if (this.resume) return;
    const next = { currentMs, endMs, bpm: Math.round(bpm) };
    const last = this.lastPosition;
    // Position events arrive many times a second; the UI shows whole seconds.
    const changed =
      !last ||
      Math.floor(last.currentMs / 1000) !== Math.floor(next.currentMs / 1000) ||
      Math.floor(last.endMs / 1000) !== Math.floor(next.endMs / 1000) ||
      last.bpm !== next.bpm;
    this.lastPosition = next;
    if (changed) this.callbacks.onPositionChange?.(next);
  }

  private reportBar(index: number) {
    if (index === this.lastBar) return;
    this.lastBar = index;
    this.callbacks.onBarChange?.(index);
  }

  private get track() {
    return this.score.tracks[this.trackIndex]!;
  }

  private applyView(view: TrackView) {
    applyTrackView(this.track, view);
  }

  /** Writes pan values into the model. Returns whether any changed. */
  private applyPans(mix: MixerSettings): boolean {
    let changed = false;
    mix.tracks.forEach((trackMix, index) => {
      const info = this.score.tracks[index]?.playbackInfo;
      const balance = gpFromPan(trackMix.pan);
      if (info && info.balance !== balance) {
        info.balance = balance;
        changed = true;
      }
    });
    return changed;
  }

  /** Sends the mix to the synthesizer. With `previous`, only what changed. */
  private applyMix(previous: MixerSettings | null, next: MixerSettings) {
    const { api } = this;
    if (previous?.master !== next.master) api.masterVolume = next.master;
    next.tracks.forEach((trackMix, index) => {
      const track = this.score.tracks[index];
      if (!track) return;
      const before = previous?.tracks[index];
      if (before?.volume !== trackMix.volume) api.changeTrackVolume([track], trackMix.volume);
      if (before?.mute !== trackMix.mute) api.changeTrackMute([track], trackMix.mute);
      if (before?.solo !== trackMix.solo) api.changeTrackSolo([track], trackMix.solo);
    });
  }

  /** Regenerates the MIDI (needed for pan) without losing the playback position. */
  private reloadMidi() {
    const { api } = this;
    const wasPlaying = api.playerState === PlayerState.Playing;
    const tick = api.tickPosition;
    api.loadMidiForScore();
    api.tickPosition = tick;
    if (wasPlaying) api.play();
  }

  showTrack(trackIndex: number, view: TrackView) {
    const track = this.score.tracks[trackIndex];
    if (!track) return;
    this.trackIndex = trackIndex;
    this.setView(view, false);
    this.api.renderTracks([track]);
  }

  /** Changes the notation of the shown track. */
  setView(view: TrackView, render = true) {
    this.applyView(view);
    this.api.settings.notation.rhythmMode = rhythmMode(view);
    this.api.updateSettings();
    if (render) this.api.render();
  }

  setLayout(layout: Layout) {
    this.api.settings.display.layoutMode = LAYOUT_MODES[layout];
    this.api.updateSettings();
    this.api.render();
  }

  /**
   * Volume, mute, solo and master apply instantly. Pan is baked into the MIDI,
   * and regenerating it cuts off ringing notes, so during playback it is
   * applied at the next pause or stop instead.
   */
  setMix(mix: MixerSettings) {
    const previous = this.mix;
    this.mix = mix;
    if (this.ready) this.applyMix(previous, mix);
    if (!this.applyPans(mix)) return;
    if (this.playing) this.panPending = true;
    else this.reloadMidi();
  }

  /**
   * Switches instrument sounds. The current sounds keep playing while the new
   * ones download; then playback pauses briefly while the synthesizer loads
   * them, and continues from the same position. If the user switches again
   * before a download finishes, only the latest choice is loaded.
   */
  async setSoundFont(url: string): Promise<void> {
    const request = ++this.soundFontRequest;
    const isCurrent = () => request === this.soundFontRequest && !this.destroyed;
    let bytes: Uint8Array;
    try {
      bytes = await downloadSoundFont(url);
      await this.synthReady;
    } catch (error) {
      if (isCurrent()) {
        this.callbacks.onSoundFontError?.(asError(error), { previousKept: this.hasSounds });
      }
      return;
    }
    if (!isCurrent()) return;

    const { api } = this;
    // While a previous switch is still loading, keep the position from before it.
    if (this.ready) this.resume = { tick: api.tickPosition, play: this.playing };
    api.pause();
    this.setReady(false);
    this.hasSounds = false;
    api.resetSoundFonts();
    api.loadSoundFont(bytes, false);
  }

  playPause() {
    if (this.ready) this.api.playPause();
  }

  stop() {
    if (this.resume) this.resume = { tick: 0, play: false };
    this.api.stop();
  }

  /** Moves the playback cursor to the start of a bar (0-based). */
  seekToBar(barIndex: number) {
    const masterBar = this.score.masterBars[barIndex];
    if (!masterBar) return;
    const tick = this.api.tickCache?.getMasterBarStart(masterBar) ?? masterBar.start;
    this.api.tickPosition = tick;
    if (this.resume) this.resume.tick = tick; // seeking while new sounds load
    this.reportBar(barIndex);
  }

  destroy() {
    this.destroyed = true;
    this.api.destroy();
  }
}
