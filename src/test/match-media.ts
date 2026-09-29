type Listener = (event: MediaQueryListEvent) => void;

let prefersDark = false;
const listeners = new Set<Listener>();

/** Installs a controllable `window.matchMedia` (jsdom has none). */
export function installMatchMedia({ dark }: { dark: boolean }) {
  prefersDark = dark;
  listeners.clear();

  window.matchMedia = (query: string) => {
    const isDarkQuery = query.includes("prefers-color-scheme: dark");
    return {
      get matches() {
        return isDarkQuery && prefersDark;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
}

/** Simulates the OS switching between light and dark appearance. */
export function setSystemDark(dark: boolean) {
  prefersDark = dark;
  for (const listener of listeners) {
    listener({ matches: dark } as MediaQueryListEvent);
  }
}
