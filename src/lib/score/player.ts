/**
 * Adapter between the UI and alphaTab: renders a score into an element and
 * plays it with a SoundFont, with practice tools (loop, speed, metronome,
 * count-in) and what the editor needs (clicks, re-rendering after edits,
 * where beats and notes are drawn). Components talk to this class only, so
 * they can be tested without alphaTab (which needs a real browser to render
 * and play).
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

import type { Beat, Note } from "@/lib/score/model";
import type { LoopRange } from "@/lib/score/practice";
import { applyTrackView, gpFromPan, type Score, type TrackView } from "@/lib/score/score";
import type { MixerSettings } from "@/lib/tauri";

const { PlayerState, PlaybackRange } = synth;

/** A rectangle in the score's coordinates (pixels from the top left of the notation). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  /** Beats of the shown track being played (or clicked while paused). */
  onActiveBeatsChange?: (beats: Beat[]) => void;
  /** A beat (and the note, if any) was clicked. `extend`: with Shift held. */
  onBeatClick?: (target: { beat: Beat; note: Note | null; extend: boolean }) => void;
  /** The mouse was dragged onto another beat after a click. */
  onBeatDrag?: (beat: Beat) => void;
  /** Rendering finished: beat and note positions are up to date. */
  onRendered?: () => void;
  /** Bars dragged across in the score (the range to loop), or null when cleared. */
  onRangeSelect?: (range: LoopRange | null) => void;
  /** Playback reached the end of the loop and starts it again. */
  onLoopRestart?: () => void;
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

/** SF2 and SF3 files are RIFF containers of type `sfbk`. */
export function isSoundFont(bytes: Uint8Array): boolean {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  return bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "sfbk";
}

async function downloadSoundFont(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The instrument sounds could not be downloaded (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A missing file can come back as the app's index.html from a dev server.
  if (!isSoundFont(bytes)) throw new Error(`${url} is not a SoundFont.`);
  return bytes;
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function createSettings(options: ScorePlayerOptions): Settings {
  const base = import.meta.env.BASE_URL;
  const settings = new Settings();
  settings.core.fontDirectory = `${base}font/`;
  settings.core.logLevel = LogLevel.Warning;
  // Note positions, for clicking notes and drawing the edit cursor.
  settings.core.includeNoteBounds = true;
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
  /**
   * Whether playback is (or is about to be) running. Set as soon as we ask
   * alphaTab to play or pause, because its state event arrives later; a
   * SoundFont switch right after Play must still know to continue.
   */
  private playing = false;
  private destroyed = false;
  private lastPosition: PlaybackPosition | null = null;
  private lastBar = -1;
  /** Where (and whether) to continue once a new SoundFont is loaded. */
  private resume: { tick: number; play: boolean } | null = null;
  /** Increases with every SoundFont request, so only the latest one is loaded. */
  private soundFontRequest = 0;
  /**
   * The MIDI must be regenerated (pan or music changed) during playback: done
   * at the next pause, never mid-song.
   */
  private midiPending = false;
  /** Bars to loop, or null. Applied once the MIDI is loaded. */
  private loop: LoopRange | null = null;
  /** Set while the adapter itself changes the playback range. */
  private settingRange = false;
  /**
   * The range the adapter last set. alphaTab's synthesizer (in a worker)
   * reports it back later, which must not count as the user's selection.
   */
  private appliedRange: { startTick: number; endTick: number } | null = null;
  /** Suppresses "Rendering…" for re-renders after edits. */
  private quietRender = false;
  private editing = false;
  /** Shift was held on the last pointer press in the score. */
  private shiftDown = false;
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
    // alphaTab reports clicked beats without the mouse event: remember Shift.
    options.element.addEventListener(
      "pointerdown",
      (event) => {
        this.shiftDown = event.shiftKey;
      },
      { capture: true },
    );
    // alphaTab ignores SoundFonts sent before its synthesizer is ready.
    this.synthReady = new Promise((resolve) => this.api.player?.ready.on(() => resolve()));
    this.subscribe();
    this.api.renderScore(this.score, [this.trackIndex]);
    void this.setSoundFont(options.soundFontUrl);
  }

  private subscribe() {
    const { api, callbacks } = this;
    api.renderStarted.on(() => {
      if (!this.quietRender) callbacks.onRenderingChange?.(true);
    });
    api.renderFinished.on(() => {
      if (!this.quietRender) callbacks.onRenderingChange?.(false);
      this.quietRender = false;
    });
    api.postRenderFinished.on(() => {
      // alphaTab only redraws the loop highlight when clicks select ranges.
      if (this.loop && this.editing) this.highlightLoop();
      callbacks.onRendered?.();
    });
    api.playerStateChanged.on((e) => {
      this.playing = e.state === PlayerState.Playing;
      callbacks.onPlayingChange?.(this.playing);
      if (!this.playing && this.midiPending) {
        this.midiPending = false;
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
    api.activeBeatsChanged.on((e) => {
      if (this.playing) callbacks.onActiveBeatsChange?.(this.ownBeats(e.activeBeats));
    });
    // playedBeatChanged only fires during playback; a click moves the cursor while paused too.
    api.beatMouseDown.on((beat) => {
      this.reportBar(beat.voice.bar.index);
      if (this.editing) this.seekToBeat(beat);
      if (!this.playing) callbacks.onActiveBeatsChange?.(this.ownBeats([beat]));
      // The note (if any) is reported right after the beat: wait for it.
      const extend = this.shiftDown;
      this.clickedNote = null;
      queueMicrotask(() => callbacks.onBeatClick?.({ beat, note: this.clickedNote, extend }));
    });
    api.noteMouseDown.on((note) => {
      this.clickedNote = note;
    });
    api.beatMouseMove.on((beat) => {
      if (this.editing) callbacks.onBeatDrag?.(beat);
    });
    api.playbackRangeChanged.on((e) => this.onPlaybackRangeChanged(e.playbackRange));
    api.playerFinished.on(() => {
      if (this.loop) callbacks.onLoopRestart?.();
    });
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
      this.applyLoop();
      const resume = this.resume;
      this.resume = null;
      if (resume) api.tickPosition = resume.tick;
      this.setReady(true);
      if (resume?.play) {
        this.playing = true;
        api.play();
      }
    });
    player.soundFontLoadFailed.on((error) => {
      this.soundFontErrors.add(error);
      callbacks.onSoundFontError?.(error, { previousKept: false });
    });
  }

  private clickedNote: Note | null = null;

  /** The beats that belong to the shown track. */
  private ownBeats(beats: readonly Beat[]): Beat[] {
    return beats.filter((beat) => beat.voice.bar.staff.track === this.track);
  }

  private setReady(ready: boolean) {
    if (this.ready === ready) return;
    this.ready = ready;
    this.callbacks.onReadyChange?.(ready);
  }

  private reportPosition(currentMs: number, endMs: number, bpm: number) {
    // While new sounds or a regenerated MIDI load, alphaTab reports position 0;
    // the real one comes back once playback is ready again.
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
    // alphaTab rewinds to 0 while it loads the new MIDI: return to this
    // position (and hide the rewind) once it is ready again. A pending
    // SoundFont switch already knows where to continue.
    this.resume ??= { tick: api.tickPosition, play: api.playerState === PlayerState.Playing };
    api.loadMidiForScore();
    api.tickPosition = this.resume.tick;
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
    this.regenerateMidi();
  }

  /** Regenerates the MIDI now, or at the next pause during playback. */
  private regenerateMidi() {
    if (this.playing) this.midiPending = true;
    else this.reloadMidi();
  }

  /**
   * Shows the score again after the music changed (edits, undo, track
   * changes): re-renders without the "Rendering…" status and regenerates the
   * MIDI (at the next pause during playback, like pan). `trackIndex` is where
   * the shown track is now, and `mix` the mix in the new track order.
   */
  refresh({ trackIndex, view, mix }: { trackIndex: number; view: TrackView; mix: MixerSettings }) {
    const track = this.score.tracks[trackIndex];
    if (!track) return;
    this.trackIndex = trackIndex;
    this.mix = mix;
    this.applyPans(mix);
    this.applyView(view);
    this.quietRender = true;
    this.api.renderTracks([track]);
    this.regenerateMidi();
  }

  /**
   * Edit mode: clicks place the edit cursor (and still move the playback
   * cursor), and dragging selects beats to edit instead of a range to play.
   */
  setEditing(editing: boolean) {
    this.editing = editing;
    this.api.settings.player.enableUserInteraction = !editing;
    this.api.updateSettings();
  }

  /** Loops `range` (whole bars), or stops looping with null. */
  setLoop(range: LoopRange | null) {
    this.loop = range;
    this.applyLoop();
  }

  private applyLoop() {
    const { api } = this;
    const loop = this.loop;
    this.settingRange = true;
    try {
      if (!loop) {
        this.appliedRange = null;
        api.isLooping = false;
        api.playbackRange = null;
        api.clearPlaybackRangeHighlight();
        return;
      }
      const cache = api.tickCache;
      const first = this.score.masterBars[loop.start];
      const last = this.score.masterBars[loop.end];
      if (!cache || !first || !last) return; // applied once the MIDI is loaded
      const range = new PlaybackRange();
      range.startTick = cache.getMasterBarStart(first);
      range.endTick = cache.getMasterBarStart(last) + last.calculateDuration();
      this.appliedRange = { startTick: range.startTick, endTick: range.endTick };
      api.playbackRange = range;
      api.isLooping = true;
      this.highlightLoop();
      const tick = api.tickPosition;
      if (tick < range.startTick || tick >= range.endTick) {
        api.tickPosition = range.startTick;
        if (this.resume) this.resume.tick = range.startTick;
      }
    } finally {
      this.settingRange = false;
    }
  }

  private highlightLoop() {
    const loop = this.loop;
    const staff = this.track.staves[0];
    const start = staff?.bars[loop?.start ?? -1]?.voices[0]?.beats[0];
    const end = staff?.bars[loop?.end ?? -1]?.voices[0]?.beats.at(-1);
    if (start && end) this.api.highlightPlaybackRange(start, end);
  }

  /** A range selected with the mouse: reported as whole bars (and snapped to them). */
  private onPlaybackRangeChanged(range: synth.PlaybackRange | null) {
    if (this.settingRange) return;
    const applied = this.appliedRange;
    if (range && applied?.startTick === range.startTick && applied.endTick === range.endTick) {
      return; // our own loop, reported back by the synthesizer
    }
    const cache = this.api.tickCache;
    if (!range || !cache) {
      // A click clears alphaTab's range; a loop stays until it is turned off.
      if (this.loop) this.applyLoop();
      else this.callbacks.onRangeSelect?.(null);
      return;
    }
    const barAt = (tick: number) => {
      const bars = this.score.masterBars;
      let index = 0;
      for (let i = 0; i < bars.length; i++) {
        if (cache.getMasterBarStart(bars[i]!) <= tick) index = i;
      }
      return index;
    };
    // The end tick is where the range stops (exclusive).
    const selected = {
      start: barAt(range.startTick),
      end: barAt(Math.max(range.startTick, range.endTick - 1)),
    };
    if (this.loop) this.setLoop(selected);
    this.callbacks.onRangeSelect?.(selected);
  }

  /** Playback speed in percent (100 = as written). */
  setSpeed(percent: number) {
    this.api.playbackSpeed = percent / 100;
  }

  setMetronome(on: boolean) {
    this.api.metronomeVolume = on ? 1 : 0;
  }

  setCountIn(on: boolean) {
    this.api.countInVolume = on ? 1 : 0;
  }

  /** Where a beat is drawn: one rectangle per staff (standard notation, tab). */
  beatRects(beat: Beat): Rect[] {
    return (this.api.boundsLookup?.findBeats(beat) ?? []).map((bounds) => {
      const bar = bounds.barBounds.visualBounds;
      return { x: bounds.realBounds.x, y: bar.y, w: bounds.realBounds.w, h: bar.h };
    });
  }

  /** Where a note's head (or fret number) is drawn, on each staff. */
  noteRects(note: Note): Rect[] {
    const beats = this.api.boundsLookup?.findBeats(note.beat) ?? [];
    return beats.flatMap((bounds) =>
      (bounds.notes ?? [])
        .filter((n) => n.note === note)
        .map(({ noteHeadBounds: b }) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    );
  }

  /** Moves the playback cursor to a beat. */
  seekToBeat(beat: Beat) {
    const tick = this.api.tickCache?.getBeatStart(beat);
    if (tick === undefined) return;
    this.api.tickPosition = tick;
    if (this.resume) this.resume.tick = tick;
    this.reportBar(beat.voice.bar.index);
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
    this.playing = false;
    api.pause();
    this.setReady(false);
    this.hasSounds = false;
    api.resetSoundFonts();
    api.loadSoundFont(bytes, false);
  }

  playPause() {
    if (!this.ready) return;
    this.playing = !this.playing;
    this.api.playPause();
  }

  stop() {
    if (this.resume) this.resume = { tick: 0, play: false };
    this.playing = false;
    this.api.stop();
    this.callbacks.onActiveBeatsChange?.([]);
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
