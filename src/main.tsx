import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { AppProviders } from "@/providers/app-providers";
import "./index.css";

/** The splash (index.html) stays one full loop of the animation (2.3 s). */
const SPLASH_MIN_MS = 2400;

/** Fades the startup splash out and removes it. */
function hideSplash(startedAt: number) {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const remove = () => splash.remove();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  setTimeout(
    () => {
      splash.classList.add("done");
      if (reduced) remove();
      else {
        splash.addEventListener("transitionend", remove, { once: true });
        setTimeout(remove, 600); // in case the transition never runs
      }
    },
    Math.max(0, SPLASH_MIN_MS - (performance.now() - startedAt)),
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
hideSplash(0);
