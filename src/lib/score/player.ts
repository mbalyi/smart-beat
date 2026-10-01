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
  midi,
  NotationElement,
  PlayerMode,
  PlayerOutputMode,
  ScrollMode,
  Settings,
  StaveProfile,
  synth,
  TabRhythmMode,
} from "@coderline/alphatab";

import { busMixes, NativeEngine, trackChannels } from "@/lib/audio/native-engine";
import { concatSamples, type RenderedAudio } from "@/lib/export/wav";
import { playableDrumKey } from "@/lib/score/drum-map";
import {
  mirrorBeatOf,
  mirrorNoteOf,
  mirrorOf,
  realBeatOf,
  realNoteOf,
  removeMirrorNotes,
} from "@/lib/score/drum-tab";
import { approximateSilentEffects, remapSilentDrums } from "@/lib/score/effect-sound";
import type { Beat, Note } from "@/lib/score/model";
import type { LoopRange } from "@/lib/score/practice";
import { applyTrackView, gpFromPan, type Score, type TrackView } from "@/lib/score/score";
import {
  createCursorHandler,
  Delayer,
  measureLatency,
  outputLatencyMs,
  readSyncOffset,
  type LatencyInfo,
} from "@/lib/score/sync";
import { allTrackEffects, isAudible } from "@/lib/score/mixer";
import {
  renderEngineAudio,
  type BlockProblem,
  type EngineMeters,
  type MixerSettings,
} from "@/lib/tauri";

const { PlayerState, PlaybackRange } = synth;

/** MIDI channel 10, where General MIDI plays drums (0-based). */
const PERCUSSION_CHANNEL = 9;

/** Sample rate of exported audio, and how much sound is rendered at a time (ms). */
const EXPORT_SAMPLE_RATE = 44_100;
const EXPORT_CHUNK_MS = 1_000;

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
  /** Native engine only: peak levels of each track and the master while playing. */
  onMeters?: (meters: EngineMeters) => void;
  /** Native engine only: effect blocks that cannot run (per track, and the master's). */
  onEffectProblems?: (problems: { tracks: BlockProblem[][]; master: BlockProblem[] }) => void;
}

/**
 * Who makes the sound: alphaTab's synthesizer in the webview, or the native
 * engine with effect chains (desktop app only, ADR 0002).
 */
export type AudioEngineKind = "alphatab" | "native";

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
  /** Default: alphaTab. */
  audioEngine?: AudioEngineKind;
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
  // With the native engine alphaTab only follows its clock (external media).
  settings.player.playerMode =
    options.audioEngine === "native"
      ? PlayerMode.EnabledExternalMedia
      : PlayerMode.EnabledSynthesizer;
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
  /** What the audio output reports about its delay (measured when playback first starts). */
  private latencyInfo: LatencyInfo = {};
  private latencyMeasured = false;
  /**
   * alphaTab's position events come when sound is handed to the audio graph,
   * not when it is heard: what the UI shows while playing is delayed by the
   * output latency (see lib/score/sync.ts).
   */
  private readonly delayer = new Delayer(() =>
    !this.playing
      ? 0
      : this.engine
        ? Math.max(0, readSyncOffset())
        : outputLatencyMs(this.latencyInfo, readSyncOffset()),
  );
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
  /** The native engine, when it makes the sound (null: alphaTab's synthesizer). */
  private readonly engine: NativeEngine | null;
  /** alphaTab has the MIDI and is ready (native engine: waits for the engine's sounds too). */
  private alphaTabReady = false;

  constructor(options: ScorePlayerOptions, callbacks: ScorePlayerCallbacks = {}) {
    this.score = options.score;
    this.trackIndex = options.trackIndex;
    this.mix = options.mix;
    this.callbacks = callbacks;

    // Pan is part of the generated MIDI, so it must be in the model before playback.
    this.applyPans(options.mix);
    this.applyView(options.view);

    this.api = new AlphaTabApi(options.element, createSettings(options));
    this.engine =
      options.audioEngine === "native"
        ? new NativeEngine({
            onMeters: (meters) => callbacks.onMeters?.(meters),
            onError: (error) => callbacks.onError?.(error),
          })
        : null;
    if (this.engine) {
      const output = this.api.player?.output as synth.IExternalMediaSynthOutput | undefined;
      if (output) this.engine.attach(output);
    }
    // The native engine reports what is heard (its output latency is already
    // taken off): only the user's offset is added.
    this.api.customCursorHandler = createCursorHandler(this.delayer, !options.reducedMotion);
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
    this.hasMirror = this.score.tracks.some((t) => mirrorOf(t) !== null);
    this.api.settings.notation.elements.set(NotationElement.GuitarTuning, !this.hasMirror);
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
      if (this.playing && !this.latencyMeasured && !this.engine) {
        this.latencyMeasured = true;
        void measureLatency().then((info) => {
          if (!this.destroyed) this.latencyInfo = info;
        });
      }
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
      this.delayer.run(() =>
        this.reportPosition(e.currentTime, e.endTime, e.modifiedTempo || e.originalTempo),
      ),
    );
    // alphaTab leaves slap, pop, tapping, pick strokes and wah silent: make them
    // audible in the MIDI it just generated (its tick lookup is ready by now).
    api.midiLoad.on((file) => {
      const lookup = api.tickCache;
      if (lookup) approximateSilentEffects(file, lookup);
      remapSilentDrums(file); // the SoundFont has no sample for some drum numbers
      removeMirrorNotes(file); // the drum tab's mirror staff is silent
      this.engine
        ?.loadSong(file, trackChannels(this.score))
        .catch((error: unknown) => callbacks.onError?.(asError(error)));
    });
    api.playedBeatChanged.on((beat) =>
      this.delayer.run(() => this.reportBar(beat.voice.bar.index)),
    );
    api.activeBeatsChanged.on((e) => {
      if (this.playing) {
        this.delayer.run(() => callbacks.onActiveBeatsChange?.(this.ownBeats(e.activeBeats)));
      }
    });
    // playedBeatChanged only fires during playback; a click moves the cursor while paused too.
    api.beatMouseDown.on((clicked) => {
      // A click on the drum tab is a click on the drum beat it shows.
      const beat = realBeatOf(clicked);
      this.delayer.clear(); // the click moves the cursor: what waits belongs to the old position
      this.reportBar(beat.voice.bar.index);
      if (this.editing) this.seekToBeat(beat);
      if (!this.playing) callbacks.onActiveBeatsChange?.(this.ownBeats([beat]));
      // The note (if any) is reported right after the beat: wait for it.
      const extend = this.shiftDown;
      this.clickedNote = null;
      queueMicrotask(() => callbacks.onBeatClick?.({ beat, note: this.clickedNote, extend }));
    });
    api.noteMouseDown.on((note) => {
      this.clickedNote = realNoteOf(note);
    });
    api.beatMouseMove.on((beat) => {
      if (this.editing) callbacks.onBeatDrag?.(realBeatOf(beat));
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
      this.alphaTabReady = true;
      // The native engine's sounds load separately (see setSoundFont).
      if (this.engine && !this.engine.soundFont) return;
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

  /** The beats that belong to the shown track (drum-tab beats as their drum beats). */
  private ownBeats(beats: readonly Beat[]): Beat[] {
    return [...new Set(beats.map(realBeatOf))].filter(
      (beat) => beat.voice.bar.staff.track === this.track,
    );
  }

  /** The drum tab's mirror staff exists (its beats must be in the MIDI's tick lookup). */
  private hasMirror = false;

  /**
   * After the view changed: the tuning label means nothing on a drum tab, and
   * a mirror staff that appeared or went away needs a new MIDI (for the cursor).
   */
  private afterViewChange() {
    const mirror = this.score.tracks.some((t) => mirrorOf(t) !== null);
    this.api.settings.notation.elements.set(NotationElement.GuitarTuning, !mirror);
    this.api.updateSettings();
    if (mirror !== this.hasMirror) {
      this.hasMirror = mirror;
      this.regenerateMidi();
    }
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
    const next = { currentMs, endMs, bpm: Math.round(bpm * 10) / 10 }; // tempos can have decimals
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
    if (this.engine) {
      this.engine.setMix(busMixes(next));
      this.applyEffects(previous, next);
      return;
    }
    next.tracks.forEach((trackMix, index) => {
      const track = this.score.tracks[index];
      if (!track) return;
      const before = previous?.tracks[index];
      if (before?.volume !== trackMix.volume) api.changeTrackVolume([track], trackMix.volume);
      if (before?.mute !== trackMix.mute) api.changeTrackMute([track], trackMix.mute);
      if (before?.solo !== trackMix.solo) api.changeTrackSolo([track], trackMix.solo);
    });
  }

  /** What the engine reported about each chain (blocks that cannot run). */
  private effectProblems: { tracks: BlockProblem[][]; master: BlockProblem[] } = {
    tracks: [],
    master: [],
  };

  /**
   * Native engine: sends the chains that changed (all of them the first
   * time), so turning one knob does not rebuild every track's chain.
   */
  private applyEffects(previous: MixerSettings | null, next: MixerSettings) {
    const engine = this.engine;
    if (!engine) return;
    const report = () => this.callbacks.onEffectProblems?.(this.effectProblems);
    const fail = (error: unknown) => this.callbacks.onError?.(asError(error));
    if (!previous || previous.tracks.length !== next.tracks.length) {
      engine
        .setAllChains(allTrackEffects(next), next.masterEffects ?? [])
        .then((problems) => {
          this.effectProblems = problems;
          report();
        })
        .catch(fail);
      return;
    }
    // A missing chain and an empty one are the same (no effects).
    const same = (a?: unknown[], b?: unknown[]) => a === b || (!a?.length && !b?.length);
    next.tracks.forEach((_, i) => {
      if (same(previous.effects?.[i], next.effects?.[i])) return;
      engine
        .setChain(i, next.effects?.[i] ?? [])
        .then((problems) => {
          const tracks = [...this.effectProblems.tracks];
          tracks[i] = problems;
          this.effectProblems = { ...this.effectProblems, tracks };
          report();
        })
        .catch(fail);
    });
    if (!same(previous.masterEffects, next.masterEffects)) {
      engine
        .setChain(null, next.masterEffects ?? [])
        .then((master) => {
          this.effectProblems = { ...this.effectProblems, master };
          report();
        })
        .catch(fail);
    }
  }

  /** Regenerates the MIDI (needed for pan) without losing the playback position. */
  private reloadMidi() {
    const { api } = this;
    // alphaTab rewinds to 0 while it loads the new MIDI: return to this
    // position (and hide the rewind) once it is ready again. A pending
    // SoundFont switch already knows where to continue. Whether to play is our
    // own flag: alphaTab reports a pause late, so right after one (an edit
    // straight after pausing) it would still say "playing".
    this.resume ??= { tick: api.tickPosition, play: this.playing };
    api.loadMidiForScore();
    api.tickPosition = this.resume.tick;
  }

  showTrack(trackIndex: number, view: TrackView) {
    const track = this.score.tracks[trackIndex];
    if (!track) return;
    this.trackIndex = trackIndex;
    this.applyView(view);
    this.api.settings.notation.rhythmMode = rhythmMode(view);
    this.afterViewChange();
    this.api.renderTracks([track]);
  }

  /** Changes the notation of the shown track. */
  setView(view: TrackView) {
    this.applyView(view);
    this.api.settings.notation.rhythmMode = rhythmMode(view);
    this.afterViewChange();
    this.api.render();
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
    this.hasMirror = this.score.tracks.some((t) => mirrorOf(t) !== null);
    this.api.settings.notation.elements.set(NotationElement.GuitarTuning, !this.hasMirror);
    this.api.updateSettings();
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
        this.engine?.setLoop(null);
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
      this.engine?.setLoop(this.appliedRange);
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
    this.engine?.setMetronome(on ? 1 : 0);
  }

  /** Count-in (alphaTab's synthesizer only; the native engine has none yet). */
  setCountIn(on: boolean) {
    this.api.countInVolume = on ? 1 : 0;
  }

  /**
   * Plays one drum sound now (the kit picker): through the native engine, or
   * alphaTab's synthesizer once its sounds are loaded.
   */
  previewDrum(key: number) {
    const sound = playableDrumKey(key);
    if (this.engine) {
      this.engine.preview(PERCUSSION_CHANNEL, sound);
      return;
    }
    if (!this.hasSounds) return;
    const file = new midi.MidiFile();
    file.addEvent(new midi.NoteOnEvent(0, 0, PERCUSSION_CHANNEL, sound, 100));
    file.addEvent(new midi.NoteOffEvent(0, file.division, PERCUSSION_CHANNEL, sound, 0));
    this.api.player?.playOneTimeMidiFile(file);
  }

  /** Whether the native engine makes the sound. */
  get usesNativeEngine(): boolean {
    return this.engine !== null;
  }

  /** Where a beat is drawn: one rectangle per staff (standard notation, tab, drum tab). */
  beatRects(beat: Beat): Rect[] {
    const mirror = mirrorBeatOf(beat);
    const beats = mirror && mirror !== beat ? [beat, mirror] : [beat];
    return beats
      .flatMap((b) => this.api.boundsLookup?.findBeats(b) ?? [])
      .map((bounds) => {
        const bar = bounds.barBounds.visualBounds;
        return { x: bounds.realBounds.x, y: bar.y, w: bounds.realBounds.w, h: bar.h };
      });
  }

  /** Where a note's head (or fret number) is drawn, on each staff. */
  noteRects(note: Note): Rect[] {
    const mirror = mirrorNoteOf(note);
    return [note, ...(mirror ? [mirror] : [])].flatMap((n) =>
      (this.api.boundsLookup?.findBeats(n.beat) ?? []).flatMap((bounds) =>
        (bounds.notes ?? [])
          .filter((drawn) => drawn.note === n)
          .map(({ noteHeadBounds: b }) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
      ),
    );
  }

  /** Moves the playback cursor to a beat. */
  seekToBeat(beat: Beat) {
    const tick = this.api.tickCache?.getBeatStart(beat);
    if (tick === undefined) return;
    this.delayer.clear();
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

    if (this.engine) {
      await this.useEngineSoundFont(url, bytes, isCurrent);
      return;
    }

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

  /** Native engine: hands the sounds to the engine, then playback is ready. */
  private async useEngineSoundFont(url: string, bytes: Uint8Array, isCurrent: () => boolean) {
    const engine = this.engine!;
    const wasPlaying = this.playing;
    if (wasPlaying) this.api.pause();
    this.setReady(false);
    try {
      await engine.useSoundFont(url.split("/").pop() ?? url, bytes);
    } catch (error) {
      if (isCurrent()) {
        this.callbacks.onSoundFontError?.(asError(error), { previousKept: this.hasSounds });
      }
      return;
    }
    if (!isCurrent()) return;
    this.hasSounds = true;
    if (this.alphaTabReady) {
      this.applyMix(null, this.mix);
      this.applyLoop();
      this.setReady(true);
      if (wasPlaying) {
        this.playing = true;
        this.api.play();
      }
    }
  }

  playPause() {
    if (!this.ready) return;
    this.playing = !this.playing;
    this.api.playPause();
  }

  /** Pauses playback (a song whose tab is hidden must not keep playing). */
  pause() {
    if (this.ready && this.playing) this.playPause();
  }

  /** Zooms the notation (1 = 100%). */
  setZoom(scale: number) {
    this.api.settings.display.scale = scale;
    this.api.updateSettings();
    this.api.render();
  }

  stop() {
    if (this.resume) this.resume = { tick: 0, play: false };
    this.playing = false;
    this.delayer.clear();
    this.api.stop();
    this.callbacks.onActiveBeatsChange?.([]);
  }

  /** Moves the playback cursor to the start of a bar (0-based). */
  seekToBar(barIndex: number) {
    const masterBar = this.score.masterBars[barIndex];
    if (!masterBar) return;
    const tick = this.api.tickCache?.getMasterBarStart(masterBar) ?? masterBar.start;
    this.delayer.clear();
    this.api.tickPosition = tick;
    if (this.resume) this.resume.tick = tick; // seeking while new sounds load
    this.reportBar(barIndex);
  }

  /**
   * Renders the whole song with the current mix (volumes, mute and solo, pan,
   * master) to sound, without playing it: for the WAV export. `onProgress`
   * gets the fraction done (0…1). Needs the instrument sounds to be loaded.
   */
  async renderAudio(onProgress?: (fraction: number) => void): Promise<RenderedAudio> {
    if (!this.ready)
      throw new Error("The instrument sounds are still loading. Try again in a moment.");
    this.pause();
    if (this.engine) {
      // Rendered by the engine, with the effect chains.
      onProgress?.(0);
      const samples = await renderEngineAudio(EXPORT_SAMPLE_RATE);
      onProgress?.(1);
      return { samples, sampleRate: EXPORT_SAMPLE_RATE, channels: 2 };
    }
    const trackVolume = new Map<number, number>();
    this.score.tracks.forEach((_, index) => {
      const mix = this.mix.tracks[index];
      trackVolume.set(index, mix && isAudible(this.mix, index) ? mix.volume : 0);
    });
    const options = {
      sampleRate: EXPORT_SAMPLE_RATE,
      useSyncPoints: false,
      masterVolume: this.mix.master,
      metronomeVolume: 0,
      trackVolume,
      trackTranspositionPitches: new Map<number, number>(),
    } as Parameters<AlphaTabApi["exportAudio"]>[0];
    const exporter = await this.api.exportAudio(options);
    const chunks: Float32Array[] = [];
    try {
      for (;;) {
        const chunk = await exporter.render(EXPORT_CHUNK_MS);
        if (!chunk) break;
        chunks.push(chunk.samples);
        if (chunk.endTime > 0) onProgress?.(Math.min(1, chunk.currentTime / chunk.endTime));
      }
    } finally {
      exporter.destroy();
    }
    onProgress?.(1);
    // alphaTab's synthesizer is stereo: interleaved left and right samples.
    return { samples: concatSamples(chunks), sampleRate: EXPORT_SAMPLE_RATE, channels: 2 };
  }

  destroy() {
    this.destroyed = true;
    this.engine?.destroy();
    this.delayer.clear();
    this.api.destroy();
  }
}
