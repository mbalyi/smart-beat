/**
 * How a lane's menu asks the open song to show the sample browser or its Add samples dialog. The
 * song's workspace owns the Inspector and the dialog; the menu only sends requests (it sits deep
 * in the track list and does not know the Inspector).
 */
export type SamplesRequest = "show" | "import";

const EVENT = "smart-beat:samples";

/** `show` opens the Inspector on the Samples tab; `import` opens the Add samples dialog. */
export function requestSamples(request: SamplesRequest): void {
  window.dispatchEvent(new CustomEvent<SamplesRequest>(EVENT, { detail: request }));
}

export function onSamplesRequest(handler: (request: SamplesRequest) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<SamplesRequest>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
