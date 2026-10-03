import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { fallBackToStill, hideSplashWhenReady } from "@/lib/splash";
import { AppProviders } from "@/providers/app-providers";
import "./index.css";

declare global {
  interface Window {
    /** Set by index.html when the splash appears. */
    __splashShownAt?: number;
  }
}

/** Fades the startup splash out once the app has drawn its first frame (and the splash was seen). */
function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const image = splash.querySelector("img");
  if (image) fallBackToStill(image, "/splash.png");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  requestAnimationFrame(() =>
    hideSplashWhenReady(splash, { shownAt: window.__splashShownAt ?? 0, reducedMotion }),
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
hideSplash();
