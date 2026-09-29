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
  playedBeatChanged = new Emitter<{ voice: { bar: { index: number } } }>();
  beatMouseDown = new Emitter<{ voice: { bar: { index: number } } }>();
  player = {
    /** The synthesizer (worker) started: SoundFonts can be loaded. */
    ready: new Emitter(),
    readyForPlayback: new Emitter(),
    soundFontLoadFailed: new Emitter<Error>(),
  };
  playerState: PlayerState = 0; // Paused
  tickPosition = 0;
  masterVolume = 1;
  tickCache = { getMasterBarStart: vi.fn(() => 3840) };
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
