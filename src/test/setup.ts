import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { installMatchMedia } from "@/test/match-media";
import { removeMediaDevices } from "@/test/media-devices";

// jsdom gaps that Radix UI relies on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

beforeEach(() => {
  installMatchMedia({ dark: false });
  // Tests start as someone who used Smart Beat before: both panels open. First-launch tests
  // remove this (#83).
  localStorage.setItem("smart-beat:layout", JSON.stringify({ mixer: true, inspector: true }));
});

afterEach(() => {
  cleanup();
  clearMocks();
  localStorage.clear();
  removeMediaDevices();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});
