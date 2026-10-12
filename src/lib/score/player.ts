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
  model,
  NotationElement,
  PlayerMode,
  PlayerOutputMode,
  ScrollMode,
  Settings,
  StaveProfile,
  synth,
  TabRhythmMode,
} from "@coderline/alphatab";

import { barOccurrences, engineExtras, type BarOccurrence } from "@/lib/audio/engine-config";
import { rgbOf, SCORE_PALETTES, type ScoreTheme } from "@/lib/score/score-theme";
import {
  busMixes,
  NativeEngine,
  trackChannels,
  type EffectProblems,
} from "@/lib/audio/native-engine";
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
import { tempoAt } from "@/lib/score/structure";
import {
  createCursorHandler,
  Delayer,
  measureLatency,
  outputLatencyMs,
  readSyncOffset,
  type LatencyInfo,
} from "@/lib/score/sync";
import { applyInterpretation } from "@/lib/score/interpretation";
import {
  FOCUS_CUT_DB,
  focusTrims,
  heardMix,
  isAudible,
  trackInterpretation,
} from "@/lib/score/mixer";
import {
  renderEngineAudio,
  type BackingInfo,
  type BackingSource,
  type EngineMeters,
  type MixerSettings,
} from "@/lib/tauri";

const { PlayerState, PlaybackRange } = synth;

/** MIDI channel 10, where General MIDI plays drums (0-based). */
const PERCUSSION_CHANNEL = 9;
/** A channel the songs leave free (the last), for the tuner's reference notes. */
const REFERENCE_CHANNEL = 15;

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
  /** Native engine only: a sound crashed, so every effect was switched off and playback stopped. */
  onEngineFault?: () => void;
  /** Native engine only: effect blocks that cannot run (per track, and the master's). */
  onEffectProblems?: (problems: EffectProblems) => void;
  /** Native engine: the bars in playback order (after every MIDI load), for the audio track. */
  onOccurrences?: (occurrences: BarOccurrence[]) => void;
}

/**
 * Who makes the sound: alphaTab's synthesizer in the webview, or the native
 * engine with effect chains (desktop app only, ADR 0003).
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
  /** The score's colours (#83); default: light. */
  theme?: ScoreTheme;
}

/** Puts a palette's colours in alphaTab's settings. */
function applyPalette(settings: Settings, theme: ScoreTheme) {
  const p = SCORE_PALETTES[theme];
  const color = (hex: string, alpha = 255) => new model.Color(...rgbOf(hex), alpha);
  const resources = settings.display.resources;
  resources.mainGlyphColor = color(p.main);
  resources.secondaryGlyphColor = color(p.secondary, p.secondaryAlpha);
  resources.staffLineColor = color(p.staffLine);
  resources.barSeparatorColor = color(p.barSeparator);
  resources.barNumberColor = color(p.barNumber);
  resources.scoreInfoColor = color(p.scoreInfo);
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
  applyPalette(settings, options.theme ?? "light");
  return settings;
}

/** Edits closer together than this share one MIDI regeneration (ms). */
const MIDI_DEBOUNCE_MS = 250;

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
  private renderStartedAt = 0;
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
    this.theme = options.theme ?? "light";
    this.callbacks = callbacks;

    // Pan is part of the generated MIDI, so it must be in the model before playback.
    this.applyPans(options.mix);
    this.applyView(options.view);

    this.api = new AlphaTabApi(options.element, createSettings(options));
    this.engine =
      options.audioEngine === "native"
        ? new NativeEngine({
            onMeters: (meters) => callbacks.onMeters?.(meters),
            onFault: () => callbacks.onEngineFault?.(),
            onError: (error) => callbacks.onError?.(error),
            // The engine starts loops again by itself and reports them (#83).
            onLoops: (count) => {
              if (!this.loop) return;
              for (let i = 0; i < count; i++) callbacks.onLoopRestart?.();
            },
          })
        : null;
    if (this.engine) {
      const output = this.api.player?.output as synth.IExternalMediaSynthOutput | undefined;
      if (output) this.engine.attach(output);
    }
    // The native engine reports what is heard (its output latency is already
    // taken off): only the user's offset is added.
    this.api.customCursorHandler = createCursorHandler(this.delayer, !options.reducedMotion);
    // alphaTab scrolls the view as the cursor moves: delay that too, so the
    // view follows what is heard (the delay is 0 while paused, e.g. for seeks).
    const ui = this.api.uiFacade as unknown as {
      scrollToY: (...args: unknown[]) => void;
      scrollToX: (...args: unknown[]) => void;
    };
    for (const method of ["scrollToY", "scrollToX"] as const) {
      const original = ui[method].bind(ui);
      ui[method] = (...args: unknown[]) => this.delayer.run(() => original(...args));
    }
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
      this.renderStartedAt = performance.now();
      if (!this.quietRender) callbacks.onRenderingChange?.(true);
    });
    api.renderFinished.on(() => {
      if (!this.quietRender) callbacks.onRenderingChange?.(false);
      this.quietRender = false;
    });
    api.postRenderFinished.on(() => {
      const took = performance.now() - this.renderStartedAt;
      if (took > 500) console.info(`[perf] render took ${Math.round(took)} ms`);
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
      applyInterpretation(
        file,
        this.score,
        lookup ?? null,
        this.mix.tracks.map((_, i) => trackInterpretation(this.mix, i)),
        trackChannels(this.score),
      );
      if (this.engine) {
        // Automation, sound switches and sync points are placed on the bars
        // as they are played (repeats included).
        this.occurrences = barOccurrences(this.score, lookup ?? null);
        callbacks.onOccurrences?.(this.occurrences);
        this.engine.prepare(engineExtras(this.mix, this.occurrences));
        this.engine
          .loadSong(file, trackChannels(this.score))
          .then(() => this.applyExtras(this.mix))
          .catch((error: unknown) => callbacks.onError?.(asError(error)));
      }
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
    // Dragging selects beats in both modes (alphaTab also highlights the range outside edit mode).
    api.beatMouseMove.on((beat) => callbacks.onBeatDrag?.(realBeatOf(beat)));
    api.playbackRangeChanged.on((e) => this.onPlaybackRangeChanged(e.playbackRange));
    api.playerFinished.on(() => {
      // The native engine reports its own loops (see onLoops).
      if (this.loop && !this.engine) callbacks.onLoopRestart?.();
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
  private applyMix(previousSaved: MixerSettings | null, nextSaved: MixerSettings) {
    const { api } = this;
    // What is heard: the practice mode on top of the saved mix (#83).
    const previous = previousSaved && heardMix(previousSaved);
    const next = heardMix(nextSaved);
    const cut = this.focusCutDb;
    if (previous?.master !== next.master) api.masterVolume = next.master;
    if (this.engine) {
      this.engine.setMix(busMixes(next, focusTrims(next, cut)));
      this.applyExtras(next);
      return;
    }
    // alphaTab's synthesizer cannot boost: the focus switch only turns the others down.
    const trims = focusTrims(next, cut).map((db) => Math.min(1, 10 ** (db / 20)));
    const previousTrims = previous
      ? focusTrims(previous, this.appliedCutDb).map((db) => Math.min(1, 10 ** (db / 20)))
      : [];
    this.appliedCutDb = cut;
    next.tracks.forEach((trackMix, index) => {
      const track = this.score.tracks[index];
      if (!track) return;
      const before = previous?.tracks[index];
      const volume = trackMix.volume * (trims[index] ?? 1);
      const volumeBefore = before ? before.volume * (previousTrims[index] ?? 1) : undefined;
      if (volumeBefore !== volume) api.changeTrackVolume([track], volume);
      if (before?.mute !== trackMix.mute) api.changeTrackMute([track], trackMix.mute);
      if (before?.solo !== trackMix.solo) api.changeTrackSolo([track], trackMix.solo);
    });
  }

  /** Native engine: every pass through a bar (ticks), from the last generated MIDI. */
  private occurrences: BarOccurrence[] = [];

  /**
   * Native engine: sends effect chains and sounds, automation, EQ, drum
   * mixes, master pan and the audio track. Only what changed is sent, so
   * turning a knob updates one block.
   */
  private applyExtras(mix: MixerSettings) {
    const engine = this.engine;
    if (!engine) return;
    if (this.occurrences.length === 0) this.occurrences = barOccurrences(this.score, null);
    engine
      .configure(engineExtras(mix, this.occurrences))
      .then((problems) => this.callbacks.onEffectProblems?.(problems))
      .catch((error: unknown) => this.callbacks.onError?.(asError(error)));
  }

  /** Regenerates the MIDI (needed for pan) without losing the playback position. */
  private reloadMidi() {
    const { api } = this;
    // alphaTab rewinds to 0 while it loads the new MIDI: return to this
    // position (and hide the rewind) once it is ready again. A pending
    // SoundFont switch already knows where to continue. Whether to play is our
    // own flag: alphaTab reports a pause late, so right after one (an edit
    // straight after pausing) it would still say "playing".
    // Kept locally: loading the MIDI can finish (and clear `resume`) at once.
    const resume = (this.resume ??= { tick: api.tickPosition, play: this.playing });
    api.loadMidiForScore();
    api.tickPosition = resume.tick;
  }

  showTrack(trackIndex: number, view: TrackView) {
    const track = this.score.tracks[trackIndex];
    if (!track) return;
    this.trackIndex = trackIndex;
    // alphaTab draws the previous track's tuning over a drum tab shown straight
    // from another track (seen in 1.8.4). Showing the drum track's score first,
    // then its drum tab, draws it correctly (#53).
    const drumTab = (track.staves[0]?.isPercussion ?? false) && view.notation !== "score";
    const first = drumTab ? { ...view, notation: "score" as const } : view;
    this.applyView(first);
    this.api.settings.notation.rhythmMode = rhythmMode(first);
    this.afterViewChange();
    this.api.renderTracks([track]);
    if (drumTab) this.setView(view);
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
  /** How far the focus turns the other tracks down (dB, at most 0). */
  private focusCutDb = FOCUS_CUT_DB;
  /** The cut the synthesizer's volumes were last set with. */
  private appliedCutDb = FOCUS_CUT_DB;

  /** Changes how far the focus turns the other tracks down (#83). */
  setFocusCut(db: number) {
    if (db === this.focusCutDb) return;
    this.focusCutDb = db;
    if (this.ready) this.applyMix(null, this.mix);
  }

  setMix(mix: MixerSettings) {
    const previous = this.mix;
    this.mix = mix;
    if (this.ready) this.applyMix(previous, mix);
    // Pan and the interpretation are in the generated MIDI.
    const pansChanged = this.applyPans(mix);
    if (!pansChanged && previous.interpretation === mix.interpretation) return;
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
    this.regenerateMidiSoon();
  }

  private midiTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Typing sends an edit per key: the MIDI (and the engine's song) is made
   * once the edits pause, not for every key.
   */
  private regenerateMidiSoon() {
    if (this.midiTimer) clearTimeout(this.midiTimer);
    this.midiTimer = setTimeout(() => {
      this.midiTimer = null;
      if (!this.destroyed) this.regenerateMidi();
    }, MIDI_DEBOUNCE_MS);
  }

  /** Makes any waiting MIDI now (before playing). */
  private flushMidi() {
    if (!this.midiTimer) return;
    clearTimeout(this.midiTimer);
    this.midiTimer = null;
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

  /** Clears a range selected with the mouse outside edit mode (a loop stays). */
  clearSelection() {
    if (this.loop) return;
    this.settingRange = true;
    try {
      this.api.playbackRange = null;
      this.api.clearPlaybackRangeHighlight();
    } finally {
      this.settingRange = false;
    }
    this.callbacks.onRangeSelect?.(null);
  }

  /** Loops `range` (whole bars), or stops looping with null. */
  setLoop(range: LoopRange | null) {
    this.loop = range;
    this.applyLoop();
  }

  /** Counts a bar in before every loop (native engine only; #83). */
  private loopCountIn = false;
  setLoopCountIn(on: boolean) {
    if (on === this.loopCountIn) return;
    this.loopCountIn = on;
    this.applyLoop();
  }

  /** A bar of clicks in the tempo and time of bar `index` (beat length at normal speed). */
  private countInAt(index: number): { beats: number; beatSeconds: number } | null {
    const bar =
      this.score.masterBars[Math.max(0, Math.min(index, this.score.masterBars.length - 1))];
    if (!bar) return null;
    const beatSeconds = (60 / tempoAt(this.score, index)) * (4 / bar.timeSignatureDenominator);
    return { beats: bar.timeSignatureNumerator, beatSeconds };
  }

  private applyLoop() {
    const { api } = this;
    const loop = this.loop;
    this.settingRange = true;
    try {
      if (!loop) {
        this.engine?.setLoop(null);
        // Without a loop to take off, a range the user just dragged stays selected (#53).
        if (!this.appliedRange) return;
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
      this.engine?.setLoop(this.appliedRange, this.loopCountIn ? this.countInAt(loop.start) : null);
      api.playbackRange = range;
      api.isLooping = true;
      this.highlightLoop();
      const tick = api.tickPosition;
      if (this.restartPending || tick < range.startTick || tick >= range.endTick) {
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

  /**
   * Count-in: one bar of clicks before the song. alphaTab's own count-in
   * only exists in its synthesizer; the native engine plays and times its own
   * (the song starts right after the last click, and so does the cursor).
   */
  setCountIn(on: boolean) {
    if (!this.engine) {
      this.api.countInVolume = on ? 1 : 0;
      return;
    }
    this.api.countInVolume = 0;
    this.engine.countIn = on
      ? () => {
          const index = Math.max(0, Math.min(this.lastBar, this.score.masterBars.length - 1));
          const bar = this.score.masterBars[index];
          if (!bar) return null;
          const beatSeconds =
            (60 / tempoAt(this.score, index)) * (4 / bar.timeSignatureDenominator);
          return { beats: bar.timeSignatureNumerator, beatSeconds };
        }
      : null;
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

  /** How long a reference note sounds (ms). */
  static readonly REFERENCE_NOTE_MS = 2500;
  private referenceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Plays a reference note with an instrument (a GM program), whether or not the song plays:
   * the open strings of the tuner (#83). It rings for `REFERENCE_NOTE_MS`.
   */
  previewNote(pitch: number, program: number, durationMs = ScorePlayer.REFERENCE_NOTE_MS) {
    const channel = REFERENCE_CHANNEL;
    if (this.engine) {
      const engine = this.engine;
      // A new note cuts the previous one off, so fast entry never piles previews up (#90).
      if (this.referenceTimer !== undefined) engine.previewStop(channel);
      engine.preview(channel, pitch, 100, program);
      clearTimeout(this.referenceTimer);
      this.referenceTimer = setTimeout(() => {
        this.referenceTimer = undefined;
        engine.previewStop(channel);
      }, durationMs);
      return;
    }
    if (!this.hasSounds) return;
    const file = new midi.MidiFile();
    // At alphaTab's default 120 BPM a quarter is 0.5 s.
    const ticks = Math.round((file.division * durationMs) / 500);
    file.addEvent(new midi.ProgramChangeEvent(0, 0, channel, program));
    file.addEvent(new midi.NoteOnEvent(0, 0, channel, pitch, 100));
    file.addEvent(new midi.NoteOffEvent(0, ticks, channel, pitch, 0));
    this.api.player?.playOneTimeMidiFile(file);
  }

  /**
   * Shows `trackIndexes` together (a full score, in page layout) at a size for
   * printing. Returns a function that puts back the shown track, layout and zoom.
   */
  showForPrint(trackIndexes: number[], scale: number): () => void {
    const display = this.api.settings.display;
    const before = { scale: display.scale, layout: display.layoutMode };
    const tracks = trackIndexes
      .map((i) => this.score.tracks[i])
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    display.scale = scale;
    display.layoutMode = LayoutMode.Page;
    // Paper is white: the printed score is always in the light colours.
    applyPalette(this.api.settings, "light");
    this.api.updateSettings();
    this.quietRender = true;
    this.api.renderTracks(tracks.length > 0 ? tracks : [this.track]);
    return () => {
      display.scale = before.scale;
      display.layoutMode = before.layout;
      applyPalette(this.api.settings, this.theme);
      this.api.updateSettings();
      this.quietRender = true;
      this.api.renderTracks([this.track]);
    };
  }

  /** Whether the native engine makes the sound. */
  /** Opens a recording as the audio track (native engine only). */
  loadBacking(source: BackingSource): Promise<BackingInfo> {
    if (!this.engine)
      return Promise.reject(new Error("The audio track needs the native audio engine."));
    return this.engine.loadBacking(source);
  }

  clearBacking(): Promise<void> {
    return this.engine?.clearBacking() ?? Promise.resolve();
  }

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

  /**
   * The bar drawn at a point of the score, in the drawing's own pixels (from the top left of
   * the surface), or null between the bars. For the score's right-click menu (#83): alphaTab
   * only reports left clicks.
   */
  barAt(x: number, y: number): number | null {
    const lookup = this.api.boundsLookup;
    const beat = lookup?.getBeatAtPos(x, y);
    if (beat) return realBeatOf(beat).voice.bar.index;
    // Beside the notes of a bar: the bar the point is in.
    for (const system of lookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        const b = masterBar.visualBounds;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return masterBar.index;
      }
    }
    return null;
  }

  /** Moves the playback cursor to a beat. */
  seekToBeat(beat: Beat) {
    const tick = this.api.tickCache?.getBeatStart(beat);
    if (tick === undefined) return;
    this.delayer.clear();
    this.restartPending = false;
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
    this.flushMidi();
    this.restartPending = false;
    this.playing = !this.playing;
    this.api.playPause();
  }

  /** Pauses playback (a song whose tab is hidden must not keep playing). */
  pause() {
    if (this.ready && this.playing) this.playPause();
  }

  /** Zooms the notation (1 = 100%). */
  private theme: ScoreTheme = "light";

  /** Draws the score in light or dark colours (#83). */
  setTheme(theme: ScoreTheme) {
    if (theme === this.theme) return;
    this.theme = theme;
    applyPalette(this.api.settings, theme);
    this.api.updateSettings();
    this.quietRender = true;
    this.api.render();
  }

  setZoom(scale: number) {
    this.api.settings.display.scale = scale;
    this.api.updateSettings();
    this.api.render();
  }

  /** Practice: Stop inside a loop makes the next Play start at the loop start (#93). */
  private restartOnStop = false;
  /** Stopped at the loop start: a changed loop moves the restart point with it. */
  private restartPending = false;
  setRestartOnStop(on: boolean) {
    this.restartOnStop = on;
    if (!on) this.restartPending = false;
  }

  /** Stops playback; true when the next Play will start at the loop start. */
  stop(): boolean {
    const restart = this.restartOnStop && this.loop !== null && this.appliedRange !== null;
    if (this.resume)
      this.resume = { tick: restart ? this.appliedRange!.startTick : 0, play: false };
    this.playing = false;
    this.delayer.clear();
    this.api.stop();
    if (restart) this.api.tickPosition = this.appliedRange!.startTick;
    this.restartPending = restart;
    this.callbacks.onActiveBeatsChange?.([]);
    return restart;
  }

  /** Moves the playback cursor to the start of a bar (0-based). */
  seekToBar(barIndex: number) {
    const masterBar = this.score.masterBars[barIndex];
    if (!masterBar) return;
    const tick = this.api.tickCache?.getMasterBarStart(masterBar) ?? masterBar.start;
    this.delayer.clear();
    this.restartPending = false;
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
    // Exported as it is heard: a practice mode (backing only…) is part of it.
    const heard = heardMix(this.mix);
    const trackVolume = new Map<number, number>();
    this.score.tracks.forEach((_, index) => {
      const mix = heard.tracks[index];
      trackVolume.set(index, mix && isAudible(heard, index) ? mix.volume : 0);
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
    if (this.midiTimer) clearTimeout(this.midiTimer);
    this.engine?.destroy();
    this.delayer.clear();
    this.api.destroy();
  }
}
