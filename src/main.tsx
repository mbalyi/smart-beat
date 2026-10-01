import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { AppProviders } from "@/providers/app-providers";
import "./index.css";

/** One full loop of the animation (2.3 s, a little more to be safe). */
const SPLASH_LOOP_MS = 2400;
/** Gives up waiting for the video to start (it may be blocked) and lets the app show. */
const SPLASH_GIVE_UP_MS = 8000;

declare global {
  interface Window {
    /** Set by index.html when the splash video starts playing. */
    __splashPlayingAt?: number;
  }
}

/** Calls `done` once the animation has played in full from the moment it started. */
function afterOneLoop(done: () => void) {
  const waitingSince = performance.now();
  const check = () => {
    const playingAt = window.__splashPlayingAt;
    if (playingAt !== undefined) {
      setTimeout(done, Math.max(0, playingAt + SPLASH_LOOP_MS - performance.now()));
    } else if (performance.now() - waitingSince > SPLASH_GIVE_UP_MS) {
      done();
    } else {
      setTimeout(check, 50);
    }
  };
  check();
}

/** Fades the startup splash out and removes it, after the animation played once. */
function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const remove = () => splash.remove();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  afterOneLoop(() => {
    splash.classList.add("done");
    if (reduced) remove();
    else {
      splash.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 600); // in case the transition never runs
    }
  });
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
