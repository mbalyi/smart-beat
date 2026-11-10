/**
 * Which audio engine plays songs: alphaTab's synthesizer (default, works
 * everywhere) or the native engine with effect chains (desktop app only).
 */
import type { AudioEngineKind } from "@/lib/score/player";
import { isTauri } from "@/lib/tauri";

/**
 * Only the engine the user picks is remembered. Version 2 (#228): older versions also stored the
 * switches the app makes by itself (an audio track, input monitoring), so their choice is dropped
 * once and every install starts with SoundFonts.
 */
export const AUDIO_ENGINE_STORAGE_KEY = "smart-beat:audio-engine:v2";
export const LEGACY_AUDIO_ENGINE_STORAGE_KEY = "smart-beat:audio-engine";

/** Whether the native engine can be used here (the desktop app). */
export const nativeEngineAvailable = () => isTauri();

export function readAudioEnginePreference(): AudioEngineKind {
  if (!nativeEngineAvailable()) return "alphatab";
  try {
    localStorage.removeItem(LEGACY_AUDIO_ENGINE_STORAGE_KEY);
    return localStorage.getItem(AUDIO_ENGINE_STORAGE_KEY) === "native" ? "native" : "alphatab";
  } catch {
    return "alphatab";
  }
}

export function storeAudioEnginePreference(kind: AudioEngineKind) {
  try {
    localStorage.setItem(AUDIO_ENGINE_STORAGE_KEY, kind);
  } catch {
    // Not remembered, but used for this session.
  }
}
