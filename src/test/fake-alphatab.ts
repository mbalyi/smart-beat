import type { Settings, synth } from "@coderline/alphatab";

type PlayerState = synth.PlayerState;

type Handler<T> = (value: T) => void;

export class Emitter<T = void> {
  private handlers: Handler<T>[] = [];
  on(handler: Handler<T>) {
    this.handlers.push(handler);
    return () => {};
  }
  trigger(value: T) {
    for (const handler of this.handlers) handler(value);
  }
}

/** Stand-in for `AlphaTabApi` that records how the adapter drives it. */
export class FakeAlphaTabApi {
  static last: FakeAlphaTabApi;
  renderStarted = new Emitter<boolean>();
  renderFinished = new Emitter<unknown>();
  error = new Emitter<Error>();
  playerStateChanged = new Emitter<{ state: PlayerState; stopped: boolean }>();
  playerPositionChanged = new Emitter<Record<string, number>>();
  postRenderFinished = new Emitter();
  playedBeatChanged = new Emitter<{ voice: { bar: { index: number } } }>();
  activeBeatsChanged = new Emitter<{ activeBeats: unknown[] }>();
  beatMouseDown = new Emitter<unknown>();
  beatMouseMove = new Emitter<unknown>();
  noteMouseDown = new Emitter<unknown>();
  playbackRangeChanged = new Emitter<{
    playbackRange: { startTick: number; endTick: number } | null;
  }>();
  playerFinished = new Emitter();
  midiLoad = new Emitter<unknown>();
  player = {
    /** The synthesizer (worker) started: SoundFonts can be loaded. */
    ready: new Emitter(),
    readyForPlayback: new Emitter(),
    soundFontLoadFailed: new Emitter<Error>(),
  };
  /** The adapter sets its own cursor handler (see lib/score/sync.ts). */
  customCursorHandler: unknown = undefined;
  playerState: PlayerState = 0; // Paused
  tickPosition = 0;
  masterVolume = 1;
  playbackSpeed = 1;
  metronomeVolume = 0;
  countInVolume = 0;
  isLooping = false;
  playbackRange: { startTick: number; endTick: number } | null = null;
  /** Bar n starts at n × 3840 ticks (4/4); beats every 960. */
  tickCache: {
    getMasterBarStart: ReturnType<typeof vi.fn>;
    getBeatStart: ReturnType<typeof vi.fn>;
  } | null = {
    getMasterBarStart: vi.fn((bar: { index: number }) => bar.index * 3840),
    getBeatStart: vi.fn(
      (beat: { index: number; voice: { bar: { index: number } } }) =>
        beat.voice.bar.index * 3840 + beat.index * 960,
    ),
  };
  boundsLookup: { findBeats: ReturnType<typeof vi.fn> } | null = null;
  highlightPlaybackRange = vi.fn();
  clearPlaybackRangeHighlight = vi.fn();
  renderScore = vi.fn();
  renderTracks = vi.fn();
  render = vi.fn();
  updateSettings = vi.fn();
  changeTrackVolume = vi.fn();
  changeTrackMute = vi.fn();
  changeTrackSolo = vi.fn();
  loadMidiForScore = vi.fn();
  play = vi.fn();
  pause = vi.fn();
  playPause = vi.fn();
  stop = vi.fn();
  resetSoundFonts = vi.fn();
  loadSoundFont = vi.fn();
  destroy = vi.fn();

  readonly element: HTMLElement;
  readonly settings: Settings;

  constructor(element: HTMLElement, settings: Settings) {
    this.element = element;
    this.settings = settings;
    FakeAlphaTabApi.last = this;
  }
}
