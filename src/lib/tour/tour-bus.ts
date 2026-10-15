/**
 * How a tour asks the open song to show a panel or a dialog, enter Edit mode, change the practice
 * settings or play, and to put everything back when the tour ends. The song's workspace owns that
 * state; the tour only sends requests.
 */
export type TourDialog =
  | "speed-trainer"
  | "pedalboard"
  | "master-pedalboard"
  | "drum-mixer"
  | "record"
  /** Closes the tour's dialogs. */
  | "none";

export interface TourPracticeRequest {
  /** The bars to loop (0-based, both included), or `false` for no loop. */
  loop?: { start: number; end: number } | false;
  /** Percent of the song's tempo. */
  speed?: number;
  metronome?: boolean;
  countIn?: boolean;
  /** Starts the Speed Trainer on the loop, or stops it. */
  trainer?: { from: number; to: number; step: number; loopsPerStep: number } | "stop";
}

export interface TourPanelRequest {
  mixer?: boolean;
  inspector?: boolean;
  /** The inspector's tab. */
  inspectorTab?: "song" | "track";
  instrumentView?: boolean;
  editing?: boolean;
  /** Shows a track: the first drum track, the first track that is not drums, or its index. */
  track?: "drums" | "melodic" | number;
  dialog?: TourDialog;
  practice?: TourPracticeRequest;
  /** Starts (true) or stops (false) playback. */
  play?: boolean;
}

export type TourBusMessage = TourPanelRequest | "restore";

const EVENT = "smart-beat:tour-panels";

export function requestTourPanels(message: TourBusMessage): void {
  window.dispatchEvent(new CustomEvent<TourBusMessage>(EVENT, { detail: message }));
}

export function onTourPanels(handler: (message: TourBusMessage) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<TourBusMessage>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
