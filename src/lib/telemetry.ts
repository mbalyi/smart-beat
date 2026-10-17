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
  | "restart_on_stop_used"
  | "record_to_tab"
  | "pedal_add"
  | "pedal_remove"
  | "pedal_move"
  | "plugins_on"
  | "plugin_scan"
  | "plugin_add"
  | "plugin_editor_open"
  | "copy_to_instrument"
  | "audio_transcribe"
  | "settings_open"
  | "audio_input_change"
  | "piano_model_download"
  | "soundfont_select"
  | "play_soundfont"
  | "soundfont_download"
  | "soundfont_import"
  | "record_to_tab_start"
  | "record_to_tab_file"
  | "drum_normalize"
  | "track_duplicate"
  | "practice_speed"
  | "practice_range"
  | "speed_trainer_stop"
  | "speed_trainer_hold"
  | "practice_view"
  | "continuous_view"
  | "multi_track_view"
  | "tour_start"
  | "tour_finish"
  | "tour_skip"
  | "tour_close";

/** File formats for open_file and export. */
const FILE_FORMATS = [
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

/** The sound sets that are counted by name; any file the user imported is just "custom". */
const CATALOGUE_SOUNDFONTS = [
  "musescore-general",
  "generaluser-gs",
  "fluidr3-gm",
  "timbres-of-heaven",
  "arachno",
];
const SOUNDFONT_IDS = ["sonivox", "fluidr3", ...CATALOGUE_SOUNDFONTS, "custom"];

const TOURS = ["main", "editing", "speed-trainer", "effects", "record-to-tab"];

/** Fixed details per event; the wire field remains `format` for older apps. */
const EVENT_DETAILS: Partial<Record<TrackedEvent, readonly string[]>> = {
  open_file: FILE_FORMATS,
  export: FILE_FORMATS,
  save: FILE_FORMATS,
  save_as: FILE_FORMATS,
  pedal_add: [
    "gate",
    "compressor",
    "eq",
    "drive",
    "amp_sim",
    "chorus",
    "phaser",
    "tremolo",
    "delay",
    "reverb",
    "limiter",
    "amp",
    "cab",
    "plugin",
  ],
  pedal_remove: [
    "gate",
    "compressor",
    "eq",
    "drive",
    "amp_sim",
    "chorus",
    "phaser",
    "tremolo",
    "delay",
    "reverb",
    "limiter",
    "amp",
    "cab",
    "plugin",
  ],
  plugin_add: ["vst3", "clap"],
  plugin_editor_open: ["vst3", "clap"],
  copy_to_instrument: [
    "guitar",
    "electric-guitar",
    "classical-guitar",
    "guitar-7",
    "guitar-8",
    "guitar-9",
    "bass-4",
    "bass-5",
    "bass-6",
    "banjo",
    "ukulele",
    "piano",
    "other",
  ],
  record_to_tab: ["guitar", "bass", "piano", "drums"],
  record_to_tab_start: ["guitar", "bass", "piano", "drums"],
  record_to_tab_file: ["guitar", "bass", "piano", "drums"],
  sound_library_import: ["amp", "cab"],
  soundfont_select: SOUNDFONT_IDS,
  play_soundfont: SOUNDFONT_IDS,
  soundfont_download: CATALOGUE_SOUNDFONTS,
  tour_start: TOURS,
  tour_finish: TOURS,
  tour_skip: TOURS,
  tour_close: TOURS,
};

/**
 * What a sound set is called in the counters: the fixed id of a bundled or recommended one, or
 * "custom" for a file the user imported (its name is never sent).
 */
export function soundFontCounterId(font: {
  id: string;
  stored?: boolean;
  catalogue?: string | null;
}): string {
  if (!font.stored) return font.id;
  return font.catalogue ?? "custom";
}

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
 * the counters are off, and never throws or slows the UI. `format` carries a fixed event detail;
 * the Rust side only accepts details allowed for that event.
 */
export function track(event: TrackedEvent, format?: string): void {
  if (!isTauri()) return;
  // A format the core doesn't know would reject the whole event: count the event without it.
  const known = format?.toLowerCase();
  invoke<void>("track_event", {
    event,
    format: known && EVENT_DETAILS[event]?.includes(known) ? known : null,
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
