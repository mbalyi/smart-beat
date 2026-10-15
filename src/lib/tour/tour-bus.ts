/**
 * How a tour asks the open song to show a panel or enter Edit mode, and to put everything back
 * when the tour ends. The song's workspace owns that state; the tour only sends requests.
 */
export interface TourPanelRequest {
  mixer?: boolean;
  inspector?: boolean;
  instrumentView?: boolean;
  editing?: boolean;
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
