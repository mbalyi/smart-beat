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
  onSoundFontError?: (error: Error) => void;
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

function createSettings(options: ScorePlayerOptions): Settings {
  const base = import.meta.env.BASE_URL;
  const settings = new Settings();
  settings.core.fontDirectory = `${base}font/`;
  settings.core.logLevel = LogLevel.Warning;
  settings.display.layoutMode = LAYOUT_MODES[options.layout];
  settings.display.staveProfile = StaveProfile.Default; // per-staff flags decide
  settings.notation.rhythmMode = rhythmMode(options.view);
  settings.player.playerMode = PlayerMode.EnabledSynthesizer;
  settings.player.soundFont = options.soundFontUrl;
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
  private lastPosition: PlaybackPosition | null = null;
  private lastBar = -1;
  /** Position to return to once a new SoundFont is ready. */
  private resumeTick: number | null = null;
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
    this.subscribe();
    this.api.renderScore(this.score, [this.trackIndex]);
  }

  private subscribe() {
    const { api, callbacks } = this;
    api.renderStarted.on(() => callbacks.onRenderingChange?.(true));
    api.renderFinished.on(() => callbacks.onRenderingChange?.(false));
    api.playerStateChanged.on((e) => callbacks.onPlayingChange?.(e.state === PlayerState.Playing));
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
      this.applyMix(null, this.mix);
      if (this.resumeTick !== null) {
        api.tickPosition = this.resumeTick;
        this.resumeTick = null;
      }
      this.setReady(true);
    });
    player.soundFontLoadFailed.on((error) => {
      this.soundFontErrors.add(error);
      callbacks.onSoundFontError?.(error);
    });
  }

  private setReady(ready: boolean) {
    if (this.ready === ready) return;
    this.ready = ready;
    this.callbacks.onReadyChange?.(ready);
  }

  private reportPosition(currentMs: number, endMs: number, bpm: number) {
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

  setMix(mix: MixerSettings) {
    const previous = this.mix;
    this.mix = mix;
    if (this.ready) this.applyMix(previous, mix);
    if (this.applyPans(mix)) this.reloadMidi();
  }

  /** Loading a SoundFont reloads the song, so the position is restored afterwards. */
  setSoundFont(url: string) {
    this.api.pause();
    this.resumeTick = this.api.tickPosition;
    this.setReady(false);
    this.api.resetSoundFonts();
    this.api.loadSoundFont(url, false);
  }

  playPause() {
    if (this.ready) this.api.playPause();
  }

  stop() {
    this.api.stop();
  }

  /** Moves the playback cursor to the start of a bar (0-based). */
  seekToBar(barIndex: number) {
    const masterBar = this.score.masterBars[barIndex];
    if (!masterBar) return;
    this.api.tickPosition = this.api.tickCache?.getMasterBarStart(masterBar) ?? masterBar.start;
    this.reportBar(barIndex);
  }

  destroy() {
    this.api.destroy();
  }
}
