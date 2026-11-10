import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_ENGINE_STORAGE_KEY,
  LEGACY_AUDIO_ENGINE_STORAGE_KEY,
  readAudioEnginePreference,
  storeAudioEnginePreference,
} from "@/lib/audio/engine-preference";

vi.mock("@/lib/tauri", () => ({ isTauri: vi.fn(() => true) }));

describe("audio engine preference (#228)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("plays with SoundFonts on a fresh install", () => {
    expect(readAudioEnginePreference()).toBe("alphatab");
  });

  it("ignores and removes a native choice remembered by an older version", () => {
    // Older versions also remembered the switches the app made by itself (an audio track,
    // input monitoring), so a stored "native" says nothing about what the user wanted.
    localStorage.setItem(LEGACY_AUDIO_ENGINE_STORAGE_KEY, "native");
    expect(readAudioEnginePreference()).toBe("alphatab");
    expect(localStorage.getItem(LEGACY_AUDIO_ENGINE_STORAGE_KEY)).toBeNull();
  });

  it("keeps the engine the user picked", () => {
    storeAudioEnginePreference("native");
    expect(localStorage.getItem(AUDIO_ENGINE_STORAGE_KEY)).toBe("native");
    expect(readAudioEnginePreference()).toBe("native");
    storeAudioEnginePreference("alphatab");
    expect(readAudioEnginePreference()).toBe("alphatab");
  });
});
