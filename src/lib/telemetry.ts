import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/tauri";

/**
 * The features that are counted (anonymous usage counters, docs/analytics.md). Mirrors `Event` in
 * `src-tauri/src/telemetry.rs`: the Rust side refuses anything else.
 */
export type TrackedEvent =
  | "app_start"
  | "play"
  | "pause"
  | "stop"
  | "loop_on"
  | "speed_trainer_start"
  | "metronome_on"
  | "count_in_on"
  | "practice_mix"
  | "sound_change"
  | "open_file"
  | "export"
  | "save"
  | "save_as"
  | "mixer_open"
  | "effect_pedal"
  | "sound_library_import"
  | "edit"
  | "undo"
  | "redo"
  | "new_song"
  | "track_add"
  | "track_delete"
  | "solo_track"
  | "mute_track"
  | "tempo_change"
  | "transpose"
  | "copy_paste"
  | "chord_insert"
  | "notation_mode_switch"
  | "tuner"
  | "fretboard_view"
  | "piano_view"
  | "update_check"
  | "update_installed"
  | "theme_dark"
  | "theme_light"
  | "shift_select"
  | "copy"
  | "cut"
  | "delete_selection"
  | "loop_selection"
  | "practise_selection"
  | "play_selection"
  | "restart_on_stop_on"
  | "restart_on_stop_off"
  | "restart_on_stop_used";

/** File formats that may accompany `open_file` and `export` (`FORMATS` in the Rust core). */
const KNOWN_FORMATS = [
  "gp3",
  "gp4",
  "gp5",
  "gpx",
  "gp",
  "mid",
  "midi",
  "pdf",
  "wav",
  "m4a",
  "mp3",
  "musicxml",
  "ogg",
  "flac",
  "txt",
  "png",
];

/** What the Settings dialog shows (mirrors `UsageSettings` in the Rust core). */
export interface UsageSettings {
  /** The counters are switched on (they are, until the user says otherwise). */
  enabled: boolean;
  /** This build can send counters at all (release builds only). */
  available: boolean;
  /** The one-time notice has been shown. */
  noticeSeen: boolean;
}

/**
 * Counts one use of a feature. Fire-and-forget: it does nothing in a browser, does nothing when
 * the counters are off, and never throws or slows the UI. `format` is the file extension for
 * `open_file` and `export`; the Rust side only accepts known formats.
 */
export function track(event: TrackedEvent, format?: string): void {
  if (!isTauri()) return;
  // A format the core doesn't know would reject the whole event: count the event without it.
  const known = format?.toLowerCase();
  invoke<void>("track_event", {
    event,
    format: known && KNOWN_FORMATS.includes(known) ? known : null,
  }).catch(() => {});
}

/** The usage counter settings. `null` in a browser, where nothing is counted. */
export async function getUsageSettings(): Promise<UsageSettings | null> {
  if (!isTauri()) return null;
  return invoke<UsageSettings>("get_usage_settings");
}

/** Switches the counters on or off and/or records that the one-time notice was shown. */
export async function setUsageSettings(change: {
  enabled?: boolean;
  noticeSeen?: boolean;
}): Promise<UsageSettings> {
  return invoke<UsageSettings>("set_usage_settings", {
    enabled: change.enabled ?? null,
    noticeSeen: change.noticeSeen ?? null,
  });
}
