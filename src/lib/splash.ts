/**
 * The startup splash (#53): the animated logo on black, from the first frame
 * (index.html) until the app is ready, but at least {@link SPLASH_MIN_MS}, so
 * the animation is seen. Then it fades out (at once with reduced motion).
 */

/** Shortest time the splash is shown (the animation takes about 2.1 s). */
export const SPLASH_MIN_MS = 3000;
/** Longest fade; the splash is removed after it even if no `transitionend` arrives. */
const FADE_MS = 600;

export interface SplashOptions {
  /** When the splash appeared (index.html sets `window.__splashShownAt`). */
  shownAt: number;
  now?: () => number;
  reducedMotion?: boolean;
  /** Shortest time on screen (default {@link SPLASH_MIN_MS}). */
  minimumMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
}

/** Hides `splash` once it has been shown long enough; call when the app is ready. */
export function hideSplashWhenReady(splash: HTMLElement, options: SplashOptions) {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
  const wait = Math.max(0, options.shownAt + (options.minimumMs ?? SPLASH_MIN_MS) - now());
  schedule(() => {
    const remove = () => splash.remove();
    splash.classList.add("done");
    if (options.reducedMotion) {
      remove();
      return;
    }
    splash.addEventListener("transitionend", remove, { once: true });
    schedule(remove, FADE_MS);
  }, wait);
}

/**
 * Shows the static logo instead of the animation if the animation cannot be
 * loaded, so the splash is never empty.
 */
export function fallBackToStill(image: HTMLImageElement, still: string) {
  image.addEventListener(
    "error",
    () => {
      if (!image.src.endsWith(still)) image.src = still;
    },
    { once: true },
  );
}
