/**
 * Typed bridge to the Rust core (`src-tauri`). Every call degrades gracefully
 * when the UI runs in a plain browser (e.g. `pnpm dev` or Playwright).
 */
import type { PdfPage } from "@/lib/print";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import type { EffectSlot } from "@/lib/audio/effects";
import type { Interpretation } from "@/lib/score/interpretation";

/** Mirrors `MenuAction` in `src-tauri/src/menu.rs` (kebab-case). */
export type MenuAction =
  | "new-song"
  | "open"
  | "clear-recent"
  | "save"
  | "save-as"
  | "export-all"
  | "export-musicxml"
  | "export-midi"
  | "export-alphatex"
  | "export-ascii-tab"
  | "export-audio"
  | "export-audio-m4a"
  | "export-pdf"
  | "print"
  | "close-window"
  | "quit"
  | "undo"
  | "redo"
  | "toggle-edit-mode"
  | "toggle-theme"
  | "toggle-fretboard"
  | "toggle-mixer"
  | "toggle-inspector"
  | "toggle-practice-view"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-fullscreen"
  | "add-track"
  | "add-audio-track"
  | "duplicate-track"
  | "remove-track"
  | "track-settings"
  | "lyrics"
  | "transpose"
  | "bar-settings"
  | "fix-bar-durations"
  | "toggle-repeat-start"
  | "toggle-repeat-end"
  | "bend"
  | "toggle-hammer-pull"
  | "toggle-slide"
  | "toggle-vibrato"
  | "toggle-palm-mute"
  | "toggle-let-ring"
  | "toggle-dead-note"
  | "toggle-ghost-note"
  | "toggle-harmonic"
  | "toggle-accent"
  | "toggle-staccato"
  | "text"
  | "chord"
  | "scale-tool"
  | "toggle-loop"
  | "speed-trainer"
  | "toggle-metronome"
  | "toggle-count-in"
  | "shortcuts"
  | "licenses"
  | "check-for-updates"
  | "about";

/** Mirrors `MENU_EVENT` in `src-tauri/src/menu.rs`. */
export const MENU_EVENT = "menu-action";

/** Mirrors `OPEN_RECENT_EVENT` in `src-tauri/src/menu.rs`: payload is the path to open. */
export const OPEN_RECENT_EVENT = "open-recent";

/** Mirrors `RECENT_CHANGED_EVENT` in `src-tauri/src/menu.rs`: payload is the new list. */
export const RECENT_CHANGED_EVENT = "recent-changed";

/** Mirrors `AppInfo` in `src-tauri/src/commands.rs`. */
export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
}

/** Mirrors `Shortcut` in `src-tauri/src/menu.rs`. */
export interface Shortcut {
  action: MenuAction;
  menu: string;
  label: string;
  keys: string[];
  spoken: string;
}

/** Mirrors `EXTENSIONS` in `src-tauri/src/score_file.rs`. */
export const SCORE_EXTENSIONS = [
  "gp3",
  "gp4",
  "gp5",
  "gpx",
  "gp",
  "mid",
  "midi",
  "musicxml",
  "mxl",
  "xml",
  "mscx",
  "mscz",
  "atex",
  "capx",
  "txt",
] as const;

/** Mirrors `AUDIO_EXTENSIONS` in `src-tauri/src/audio/backing.rs`: audio track files. */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "oga", "aif", "aiff"] as const;

/** Mirrors `WRITE_EXTENSIONS` in `src-tauri/src/score_write.rs`. */
export const SAVE_EXTENSIONS = [
  "gp",
  "gp5",
  "gp4",
  "gp3",
  "mid",
  "midi",
  "musicxml",
  "mxl",
  "mscx",
  "mscz",
  "atex",
  "txt",
  "wav",
] as const;

/** Mirrors `ErrorKind` in `src-tauri/src/error.rs`. */
export type CommandErrorKind =
  | "not-found"
  | "unsupported-type"
  | "too-large"
  | "not-a-score"
  | "invalid-key"
  | "invalid-settings"
  | "invalid-menu-state"
  | "audio"
  | "io";

/** Mirrors `CommandError` in `src-tauri/src/error.rs`: how commands fail. */
export interface CommandError {
  kind: CommandErrorKind;
  message: string;
}

export function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as CommandError).kind === "string" &&
    typeof (error as CommandError).message === "string"
  );
}

/** Mirrors `TrackMix` in `src-tauri/src/mixer.rs`. */
export interface TrackMix {
  /** 0 (silent) to 1 (full). */
  volume: number;
  /** -1 (left) to 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
}

/** Mirrors `mixer::VERSION` in `src-tauri/src/mixer.rs`. */
export const MIXER_SETTINGS_VERSION = 2;
/** Mirrors `mixer::MIN_VERSION`: older settings files that still load. */
export const MIXER_SETTINGS_MIN_VERSION = 1;

/** Mirrors `TrackEq` in `src-tauri/src/audio/mixing.rs`: the mixer's channel EQ. */
export interface TrackEq {
  lowDb: number;
  midDb: number;
  midHz: number;
  highDb: number;
  /** Ten gains (31 Hz … 16 kHz) for the graphic EQ; absent or empty for three bands. */
  graphic?: number[];
}

/** Mirrors `Sound` in `src-tauri/src/mixer.rs`: a named effect chain. */
export interface Sound {
  name: string;
  effects: EffectSlot[];
}

/** Mirrors `SoundSwitch`: from bar `bar` (0-based) on, play sound `sound`. */
export interface SoundSwitch {
  bar: number;
  sound: number;
}

/** Mirrors `TrackSounds`. */
export interface TrackSounds {
  sounds: Sound[];
  switches: SoundSwitch[];
}

/** Mirrors `AutomationPoint`: a position in bars (0-based, fractional) and a value. */
export interface AutomationPoint {
  bar: number;
  value: number;
}

export type AutomationLaneKind = "volume" | "pan" | "mute";

/** Mirrors `TrackAutomation`. */
export interface TrackAutomation {
  enabled: boolean;
  volume: AutomationPoint[];
  pan: AutomationPoint[];
  mute: AutomationPoint[];
}

/** Mirrors `DrumElementMix`. */
export interface DrumElementMix {
  id: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

/** Mirrors `DrumMixer`. */
export interface DrumMixer {
  stereo: boolean;
  elements: DrumElementMix[];
}

/** Mirrors `BackingFilter` in `src-tauri/src/audio/backing.rs`. */
export type BackingFilter = "off" | "bassIsolate" | "guitarBand" | "centreCut";

/** Mirrors `BackingParams`: how the audio track plays. */
export interface BackingParams {
  enabled: boolean;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  eq: TrackEq;
  semitones: number;
  cents: number;
  filter: BackingFilter;
}

/** Mirrors `SyncPoint`: bar `bar` (0-based) starts at `ms` in the recording. */
export interface SyncPoint {
  bar: number;
  ms: number;
}

/** Mirrors `AudioTrack` in `src-tauri/src/mixer.rs`. */
export interface AudioTrackSettings extends BackingParams {
  name: string;
  /** Where the recording is on disk (when it is not embedded). */
  path?: string;
  /** Stored inside the song file. */
  embedded: boolean;
  sync: SyncPoint[];
}

/** Mirrors `ChainPreset`: an effect chain preset saved with the song. */
export interface SongPreset {
  name: string;
  target: string;
  effects: EffectSlot[];
}

/**
 * What the focus on a track does to the mix (#83): turn the others down, hear only that track, or
 * mute it and hear the rest. Never changes the saved levels, mutes and solos. Mirrors `FocusMode`
 * in `src-tauri/src/mixer.rs`.
 */
export type FocusMode = "othersDown" | "onlyMe" | "backing";

/** Mirrors `MixerSettings` in `src-tauri/src/mixer.rs`. */
export interface MixerSettings {
  version: number;
  /** Master volume, 0 to 1. */
  master: number;
  tracks: TrackMix[];
  /** Effect chain of each track, in score order (native audio engine). */
  effects?: EffectSlot[][];
  /** Effect chain of the master bus (at most three effects). */
  masterEffects?: EffectSlot[];
  /** How each track is played back, in score order. */
  interpretation?: Interpretation[];
  /** Master pan, -1 … 1. */
  masterPan?: number;
  /** Sounds of each track (several chains switched along the song). */
  sounds?: TrackSounds[];
  /** Channel EQ of each track. */
  eq?: TrackEq[];
  /** Volume, pan and mute automation of each track. */
  automation?: TrackAutomation[];
  /** The track in focus: the one being practised. */
  focus?: number;
  /** What the focus does to the rest of the mix (missing: the others are turned down; #83). */
  focusMode?: FocusMode;
  /** The drum mixer of each track (null when not split). */
  drums?: (DrumMixer | null)[];
  /** The imported drum kit (#40) each track plays (null: the SoundFont's own kit). */
  drumKits?: (string | null)[];
  /** A colour chosen for each track, `#rrggbb` (null: the default one; #83). */
  trackColors?: (string | null)[];
  audioTrack?: AudioTrackSettings;
  /** Effect chain presets saved with the song. */
  presets?: SongPreset[];
  /** Drum notes on a chosen line of the drum tab (#53). Mirrors `DrumLine` in `mixer.rs`. */
  drumLines?: DrumLine[];
}

/** The drum-tab line (1 bottom … 6 top) of the drum note at a position (0-based indices). */
export interface DrumLine {
  track: number;
  bar: number;
  voice: number;
  beat: number;
  note: number;
  line: number;
}

/** Mirrors `MenuState` in `src-tauri/src/menu_state.rs`: what the menu bar reflects. */
export interface MenuState {
  songOpen: boolean;
  /** What Undo would undo ("Add note"), or null. */
  undo: string | null;
  redo: string | null;
  canRemoveTrack: boolean;
  editMode: boolean;
  fretboard: boolean;
  mixer: boolean;
  inspector: boolean;
  practiceView: boolean;
  loop: boolean;
  metronome: boolean;
  countIn: boolean;
  /** The bar at the edit cursor starts a repeat. */
  repeatStart: boolean;
  /** The bar at the edit cursor ends a repeat. */
  repeatEnd: boolean;
  /** A note is under the edit cursor (or selected): the Note menu applies. */
  hasNote: boolean;
  noteEffects: NoteEffectFlags;
}

/** Mirrors `NoteEffects` in `src-tauri/src/menu_state.rs`: the Note menu's check marks. */
export interface NoteEffectFlags {
  hammerPull: boolean;
  slide: boolean;
  vibrato: boolean;
  palmMute: boolean;
  letRing: boolean;
  deadNote: boolean;
  ghostNote: boolean;
  harmonic: boolean;
  accent: boolean;
  staccato: boolean;
}

/** Mirrors `MAX_LABEL_CHARS` in `src-tauri/src/menu_state.rs`. */
export const MAX_MENU_LABEL_CHARS = 60;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  }
}

/** True when running inside the Tauri webview (or with IPC mocks installed). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

export class NotInDesktopAppError extends Error {
  constructor() {
    super("This feature is only available in the Smart Beat desktop app.");
    this.name = "NotInDesktopAppError";
  }
}

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<T>(command, args);
}

export const getAppInfo = () => call<AppInfo>("app_info");

export const getMenuShortcuts = () => call<Shortcut[]>("menu_shortcuts");

/** Subscribes to native menu actions. Resolves to an unsubscribe function. */
export async function onMenuAction(handler: (action: MenuAction) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<MenuAction>(MENU_EVENT, (event) => handler(event.payload));
}

/**
 * Shows the native Open dialog for Guitar Pro files. Resolves to the picked
 * path, or `null` if the user cancelled.
 */
export async function pickScoreFile(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: "Open a song",
    multiple: false,
    directory: false,
    filters: [
      { name: "Songs", extensions: [...SCORE_EXTENSIONS] },
      { name: "Guitar Pro files", extensions: ["gp3", "gp4", "gp5", "gpx", "gp"] },
      { name: "MusicXML files", extensions: ["musicxml", "mxl", "xml"] },
      { name: "MIDI files", extensions: ["mid", "midi"] },
      { name: "MuseScore files", extensions: ["mscx", "mscz"] },
      { name: "Text tab and alphaTex", extensions: ["txt", "atex"] },
      { name: "Capella files", extensions: ["capx"] },
    ],
  });
}

/** What the native Save dialog offers. */
export interface SaveFilter {
  name: string;
  extensions: string[];
}

/**
 * Shows the native Save dialog. Resolves to the chosen path, or `null` if the
 * user cancelled.
 */
export async function pickSavePath(
  defaultPath: string,
  filters: SaveFilter[],
  title = "Save",
): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return saveDialog({ title, defaultPath, filters });
}

/** Writes a song or export to `path` (atomically). Rejects with a {@link CommandError}. */
export async function writeScoreFile(path: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  // The bytes are the raw request body; the path travels in a header.
  await invoke<void>("write_score_file", bytes, {
    headers: { path: encodeURIComponent(path) },
  });
}

/**
 * Encodes rendered audio (the bytes of a 16-bit WAV file) as AAC and writes it
 * to the `.m4a` file `path`, with the operating system's own encoder. Rejects
 * with a {@link CommandError}; only macOS has one so far (see {@link canExportM4a}).
 */
export async function writeM4aFile(path: string, wav: Uint8Array): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  await invoke<void>("export_m4a", wav, { headers: { path: encodeURIComponent(path) } });
}

/**
 * Exports the window's print copy of the score (put in place by `printScore`) as a PDF file at
 * `path`, without a print dialog (#83). macOS only (see {@link canExportPdf}).
 */
export async function writePdfFile(path: string, page: PdfPage): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  await invoke<void>("export_pdf", { path, page });
}

/** Whether this platform exports PDF itself (mirrors `pdf::SUPPORTED` in `src-tauri/src/pdf.rs`). */
export const canExportPdf = ({ os }: Pick<AppInfo, "os">) => os === "macos";

/** Whether this platform can export `.m4a` files (mirrors `m4a::SUPPORTED` in `src-tauri/src/m4a.rs`). */
export const canExportM4a = ({ os }: Pick<AppInfo, "os">) => os === "macos";

/** The recently opened songs, most recent first. Empty in a browser. */
export async function loadRecentFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("load_recent_files");
}

/** Remembers a song as the most recent one. No-op in a browser. */
export async function addRecentFile(path: string): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("add_recent_file", { path });
}

/** Forgets a song that can no longer be opened. No-op in a browser. */
export async function removeRecentFile(path: string): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("remove_recent_file", { path });
}

export async function clearRecentFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("clear_recent_files");
}

/** Subscribes to File › Open Recent clicks. Resolves to an unsubscribe function. */
export async function onOpenRecent(handler: (path: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<string>(OPEN_RECENT_EVENT, (event) => handler(event.payload));
}

/** Subscribes to changes of the recent files list made natively (Clear Menu). */
export async function onRecentChanged(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<string[]>(RECENT_CHANGED_EVENT, (event) => handler(event.payload));
}

/** Reads a picked or dropped Guitar Pro file. Rejects with a {@link CommandError}. */
export async function readScoreFile(path: string): Promise<Uint8Array> {
  // The Rust command answers with raw bytes, which arrive as an ArrayBuffer.
  return new Uint8Array(await call<ArrayBuffer>("read_score_file", { path }));
}

/** Saved mixer settings for a song (`fileKey`: SHA-256 of its content), if any. */
export const loadMixerSettings = (fileKey: string) =>
  call<MixerSettings | null>("load_mixer_settings", { fileKey });

export const saveMixerSettings = (fileKey: string, settings: MixerSettings) =>
  call<void>("save_mixer_settings", { fileKey, settings });

/** Mixer settings stored inside a `.gp` file (null for other files, or none). */
export const readProjectSettings = (path: string) =>
  call<MixerSettings | null>("read_project_settings", { path });

/**
 * Stores mixer settings inside a `.gp` file that was just written. With
 * `embedAudio`, the loaded audio track's recording goes in too.
 */
export const writeProjectSettings = (path: string, settings: MixerSettings, embedAudio: boolean) =>
  call<void>("write_project_settings", { path, settings, embedAudio });

/** Updates the native menu bar (labels, check marks, enabled items). No-op in a browser. */
export async function updateMenuState(state: MenuState): Promise<void> {
  if (!isTauri()) return;
  await invoke("update_menu_state", { state });
}

export type FileDragEvent =
  { type: "enter" } | { type: "leave" } | { type: "drop"; paths: string[] };

/**
 * Subscribes to files being dragged onto the window. The desktop app handles
 * drops natively (the webview gets paths, not `File`s). No-op in a browser,
 * where HTML5 drag and drop is used instead.
 */
export async function onFileDrag(handler: (event: FileDragEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "enter") handler({ type: "enter" });
    else if (payload.type === "leave") handler({ type: "leave" });
    else if (payload.type === "drop") handler({ type: "drop", paths: payload.paths });
  });
}

/** Sets the native window title (e.g. to the open song). */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) {
    document.title = title;
    return;
  }
  await getCurrentWindow().setTitle(title);
}

/** Keeps the native title bar in sync with the UI theme (`null` = follow the OS). */
export async function setNativeTheme(theme: "light" | "dark" | null): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setTheme(theme);
}

const OS_NAMES: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const ARCH_NAMES: Record<string, string> = {
  aarch64: "ARM64",
  x86_64: "x64",
};

/** Human readable platform, e.g. "macOS (Apple Silicon)" or "Windows (x64)". */
export function describePlatform({ os, arch }: Pick<AppInfo, "os" | "arch">): string {
  const osName = OS_NAMES[os] ?? os;
  const archName =
    os === "macos" && arch === "aarch64" ? "Apple Silicon" : (ARCH_NAMES[arch] ?? arch);
  return `${osName} (${archName})`;
}

// --- Native audio engine and sound library (src-tauri/src/audio) ---

/** Mirrors `BusMix` in `src-tauri/src/audio/engine.rs`. */
export interface BusMix {
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Extra gain in dB (the focus switch). */
  trimDb?: number;
}

/** Mirrors `Meters` in `src-tauri/src/audio/engine.rs` (peak levels, 0…1). */
export interface EngineMeters {
  tracks: number[];
  master: number;
  /** Per track: the levels of its drum elements (empty unless split). */
  drums?: number[][];
  /** The audio track. */
  backing?: number;
  /** Gain reduction (dB) of each pedalboard slot's compressor or limiter (#39). */
  reduction?: { tracks: number[][]; master: number[] };
}

/** Mirrors `AutomationData` in `src-tauri/src/audio/mixing.rs`: lanes in ticks. */
export interface EngineAutomation {
  enabled: boolean;
  volume: [number, number][];
  pan: [number, number][];
  mute: [number, number][];
}

/** Mirrors `DrumMixData` in `src-tauri/src/audio/mod.rs`. */
export interface EngineDrumMix {
  stereo: boolean;
  elements: { keys: number[]; mix: BusMix }[];
  other: BusMix;
}

/** Mirrors `BackingSource`: where the audio track comes from. */
export type BackingSource =
  { type: "file"; path: string } | { type: "embedded"; scorePath: string; name: string };

/** Mirrors `BackingInfo`: what the engine learnt about a recording. */
export interface BackingInfo {
  name: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Loudest sample per 1/`peaksPerSecond` s (0…1). */
  peaks: number[];
  peaksPerSecond: number;
}

/** Mirrors `EngineStatus` in `src-tauri/src/audio/mod.rs`. */
export interface EngineStatus {
  running: boolean;
  sampleRate: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  latencyMs: number;
  dropouts: number;
  /** Times a sound crashed in the audio callback (effects were switched off, playback stopped). */
  faults: number;
  loadPercent: number;
  /** Loops played to the end since the last report (#83). */
  loops: number;
  meters: EngineMeters;
}

/** Mirrors `SongData` in `src-tauri/src/audio/song.rs`. */
export interface EngineSong {
  division: number;
  /** `[tick, status, data1, data2]`. */
  events: [number, number, number, number][];
  tempos: [number, number][];
  metronome: [number, boolean][];
  tracks: number[][];
  endTick: number;
}

/** Mirrors `Transport` in `src-tauri/src/audio/mod.rs`. */
export type TransportCommand =
  | { type: "play" }
  /** Clicks `beats` times, `beatSeconds` apart, then plays. */
  | { type: "countIn"; beats: number; beatSeconds: number }
  | { type: "pause" }
  | { type: "seek"; ms: number }
  | { type: "rate"; value: number }
  | {
      type: "loop";
      startTick: number | null;
      endTick: number | null;
      /** A bar of clicks before every loop (beat length at normal speed, seconds; #83). */
      countIn?: { beats: number; beatSeconds: number } | null;
    }
  | { type: "metronome"; volume: number }
  | { type: "masterVolume"; value: number }
  | { type: "masterPan"; value: number }
  | { type: "preview"; channel: number; key: number; velocity: number; program?: number }
  | { type: "previewStop"; channel: number };

/** Mirrors `BlockProblem` in `src-tauri/src/audio/chain.rs`. */
export interface BlockProblem {
  index: number;
  message: string;
}

/** Mirrors `AssetKind` in `src-tauri/src/audio/library.rs`. */
export type AssetKind = "amp" | "cab";

/** Mirrors `LibraryItem` in `src-tauri/src/audio/library.rs`. */
export interface LibraryItem {
  id: string;
  kind: AssetKind;
  name: string;
  tags: string[];
  file: string;
  sampleRate: number;
  source: string;
  builtin: boolean;
  includesCab: boolean;
  /** Something to tell the user about this file (empty when nothing). */
  note: string;
}

/** Sends a SoundFont (SF2 or SF3) to the native engine. */
export async function loadEngineSoundFont(id: string, bytes: Uint8Array): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  await invoke<void>("audio_load_soundfont", bytes, { headers: { "x-sound-font-id": id } });
}

export const startEngine = (soundFont: string) => call<EngineStatus>("audio_start", { soundFont });
export const stopEngine = () => call<void>("audio_stop");
export const loadEngineSong = (song: EngineSong) => call<void>("audio_load_song", { song });
export const engineTransport = (command: TransportCommand) =>
  call<void>("audio_transport", { command });
export const setEngineMix = (mixes: BusMix[]) => call<void>("audio_set_mix", { mixes });
export const engineState = () => call<EngineStatus>("audio_state");

/**
 * Sets the effect chain of a track (`track: null` for the master bus).
 * Resolves to the blocks that cannot run (missing library items and so on).
 */
export const setEngineChain = (track: number | null, slots: EffectSlot[], sound = 0) =>
  call<BlockProblem[]>("audio_set_chain", { track, slots, sound });

/**
 * Every sound (effect chain) of a track and where it switches: `switches` are
 * `[tick, sound]`. Resolves to the problems of each sound's chain.
 */
export const setEngineSounds = (
  track: number,
  sounds: EffectSlot[][],
  switches: [number, number][],
) => call<BlockProblem[][]>("audio_set_sounds", { track, sounds, switches });

export const setEngineAutomation = (track: number, automation: EngineAutomation) =>
  call<void>("audio_set_automation", { track, automation });

export const setEngineTrackEq = (track: number, eq: TrackEq) =>
  call<void>("audio_set_track_eq", { track, eq });

/** Splits a drum track into elements with their own mix (`null` joins it back). */
export const setEngineDrumMix = (track: number, drums: EngineDrumMix | null) =>
  call<void>("audio_set_drum_mix", { track, drums });

/** Opens a recording as the audio track. */
export const loadEngineBacking = (source: BackingSource) =>
  call<BackingInfo>("audio_load_backing", { source });

/** Audio track settings and sync points (`tick`: start of the synced bar). */
export const setEngineBacking = (params: BackingParams, sync: { tick: number; ms: number }[]) =>
  call<void>("audio_set_backing", { params, sync });

export const clearEngineBacking = () => call<void>("audio_clear_backing");

/** Native Open dialog for an audio track recording. */
export async function pickAudioFile(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: "Add an audio track",
    multiple: false,
    directory: false,
    filters: [{ name: "Audio files", extensions: [...AUDIO_EXTENSIONS] }],
  });
}

/** Interleaved stereo float samples of the whole song, with effects. */
export async function renderEngineAudio(sampleRate: number): Promise<Float32Array> {
  const buffer = await call<ArrayBuffer>("audio_render", { sampleRate });
  return new Float32Array(buffer);
}

export const listLibrary = () => call<LibraryItem[]>("library_list");
export const importLibraryFile = (path: string, kind: AssetKind) =>
  call<LibraryItem>("library_import", { path, kind });
export const updateLibraryItem = (id: string, name: string, tags: string[]) =>
  call<LibraryItem>("library_update", { id, name, tags });
export const removeLibraryItem = (id: string) => call<void>("library_remove", { id });

/** Native Open dialog for an amp capture (`.nam`) or a cabinet IR (`.wav`). */
export async function pickLibraryFile(kind: AssetKind): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: kind === "amp" ? "Import an amp or pedal capture" : "Import a cabinet impulse response",
    multiple: false,
    directory: false,
    filters:
      kind === "amp"
        ? [{ name: "Neural Amp Modeler captures", extensions: ["nam"] }]
        : [{ name: "Impulse responses (WAV)", extensions: ["wav"] }],
  });
}

// --- Drum kits (#40) ---------------------------------------------------------

/** Mirrors `LicenceKind` in `src-tauri/src/audio/kits/mod.rs`. */
export type KitLicenceKind =
  "cc0" | "public-domain" | "cc-by" | "cc-by-sa" | "other-commercial" | "unknown";

/** Mirrors `KitInfo` in `src-tauri/src/audio/kits/mod.rs`. */
export interface DrumKit {
  id: string;
  name: string;
  format: "sfz" | "sf2" | "sf3";
  licence: { kind: KitLicenceKind; text?: string; attribution?: string };
  /** Drum mixer pieces the kit has samples for, and their keys. */
  pieces: { element: string; keys: number[] }[];
  /** Drum mixer pieces it has nothing for. */
  missing: string[];
  sizeBytes: number;
  warnings: string[];
}

/** How the user answered the licence question when importing. */
export interface KitImportOptions {
  licence?: Exclude<KitLicenceKind, "unknown">;
  acceptUnknown?: boolean;
  attribution?: string;
  name?: string;
}

export const listKits = () => call<DrumKit[]>("kits_list");
export const importKit = (path: string, options: KitImportOptions = {}) =>
  call<DrumKit>("kits_import", { path, options });
export const removeKit = (id: string) => call<void>("kits_remove", { id });
/** Plays a drum track with an imported kit (null: the SoundFont's own kit). */
export const setEngineTrackKit = (track: number, kit: string | null) =>
  call<void>("audio_set_track_kit", { track, kit });

/** Native Open dialog for a drum kit. */
export async function pickKitFile(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: "Import a drum kit",
    multiple: false,
    directory: false,
    filters: [{ name: "Drum kits (SFZ, SoundFont)", extensions: ["sfz", "sf2", "sf3"] }],
  });
}
