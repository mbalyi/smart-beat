/**
 * Typed bridge to the Rust core (`src-tauri`). Every call degrades gracefully
 * when the UI runs in a plain browser (e.g. `pnpm dev` or Playwright).
 */
import { invoke } from "@/lib/invoke";
import type { PdfPage } from "@/lib/print";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { EffectSlot } from "@/lib/audio/effects";
import type { RecordedNote } from "@/lib/import/recording";
import type { Interpretation } from "@/lib/score/interpretation";

/** Mirrors `MenuAction` in `src-tauri/src/menu.rs` (kebab-case). */
export type MenuAction =
  | "new-song"
  | "open"
  | "record-models"
  | "stem-models"
  | "import-audio"
  | "record-to-tab"
  | "clear-recent"
  | "save"
  | "save-as"
  | "export-all"
  | "export-gp"
  | "export-gp5"
  | "export-gp4"
  | "export-gp3"
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
  | "practice-together"
  | "toggle-metronome"
  | "toggle-count-in"
  | "shortcuts"
  | "settings"
  | "cloud-settings"
  | "open-cloud"
  | "cloud-library"
  | "licenses"
  | "check-for-updates"
  | "tour"
  | "tour-editing"
  | "tour-speed-trainer"
  | "tour-effects"
  | "tour-record-to-tab"
  | "demo-song"
  | "whats-new"
  | "reset-tips"
  | "about";

/** Mirrors `MENU_EVENT` in `src-tauri/src/menu.rs`. */
export const MENU_EVENT = "menu-action";

/** Mirrors `OPEN_RECENT_EVENT` in `src-tauri/src/menu.rs`: payload is the path to open. */
export const OPEN_RECENT_EVENT = "open-recent";

/** Mirrors `OPEN_EXTERNAL_FILE_EVENT` in `src-tauri/src/open_file.rs`: the system queued songs to open. */
export const OPEN_EXTERNAL_FILE_EVENT = "open-external-file";

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
  | "conflict"
  | "download-timeout"
  | "network"
  | "auth-expired"
  | "invalid-code"
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
export const MIXER_SETTINGS_VERSION = 3;
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
export type BackingFilter =
  | "off"
  | "bassIsolate"
  | "guitarBand"
  | "centreCut"
  | "bassBoost"
  | "bassCut"
  | "midBoost"
  | "midCut"
  | "highBoost"
  | "highCut";

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
  /** The beat in the bar (0-based) the point is on; missing: the bar's first beat. */
  beat?: number;
}

/** Mirrors `FadeShape` in `src-tauri/src/mixer.rs`: the curve of a clip fade. */
export type FadeShape = "linear" | "equalPower" | "sCurve";

/** A clip fade: its length and curve. */
export interface ClipFade {
  ms: number;
  shape: FadeShape;
}

/** A point of a clip's gain envelope: `at` 0…1 along the clip, gain in dB. */
export interface GainPoint {
  at: number;
  db: number;
}

/** A stretch marker: source time `sourceMs` plays at `clipMs` into the clip. */
export interface StretchMarker {
  sourceMs: number;
  clipMs: number;
}

/** One recorded pass of a clip (take lanes and comping). */
export interface AudioTake {
  name: string;
  sourceId: string;
  /** Where the take starts in its source, in ms. */
  offsetMs: number;
}

/**
 * Mirrors `AudioClip`: a piece of a source on a lane. Positions are on the audio timeline, which
 * the song's sync points map onto the score (so clips follow the speed trainer and stay on the
 * bar grid).
 */
export interface AudioClip {
  id: string;
  /** Takes of the clip; `take` is the one heard. A plain clip has one take. */
  takes: AudioTake[];
  take: number;
  /** Where the clip starts on the audio timeline, in ms. */
  startMs: number;
  /** How long the clip plays, in ms of source time at playrate 1. */
  lengthMs: number;
  gainDb: number;
  mute: boolean;
  locked: boolean;
  reversed: boolean;
  semitones: number;
  cents: number;
  /** Playback speed of the clip (1 = as recorded). */
  playrate: number;
  /** A playrate other than 1 keeps the pitch. */
  preservePitch: boolean;
  fadeIn: ClipFade;
  fadeOut: ClipFade;
  envelope: GainPoint[];
  stretch: StretchMarker[];
}

/** Mirrors `AudioSource`: an audio file that clips play. */
export interface AudioSource {
  /** The SHA-256 of the file's bytes (hex). */
  id: string;
  name: string;
  /** The file extension, lower case, without the dot. */
  ext: string;
  /** Where the file is on disk (when it is not embedded). */
  path?: string;
  /** Stored inside the song file, under `SmartBeat/audio/<id>.<ext>`. */
  embedded: boolean;
  /** The entry name an old single audio track used (`SmartBeat/audio/<name>`), read until the next save. */
  legacyEntry?: string;
}

/** Mirrors `EffectAutomation`: one effect parameter changed along the song. */
export interface EffectAutomation {
  /** The effect's place in the lane chain. */
  slot: number;
  param: string;
  points: { tick: number; value: number }[];
}

/** Mirrors `LaneSend`: part of a lane sent to a bus. */
export interface LaneSend {
  bus: string;
  /** 0 … 1. */
  level: number;
}

/** Mirrors `AudioLane`: a lane of audio clips next to the tab tracks. */
export interface AudioLane extends BackingParams {
  id: string;
  name: string;
  /** A colour chosen by the user, `#rrggbb` (null: the stem colour by position). */
  color: string | null;
  /** Clip pitch also follows the song's transposition. */
  followTransposition: boolean;
  effects: EffectSlot[];
  /** Effects stop while the lane is silent. */
  autoBypass: boolean;
  automation: EffectAutomation[];
  sends: LaneSend[];
  /** The folder lane this lane sits in. */
  parent?: string;
  /** A folder lane: no clips of its own; its volume, mute and solo apply to its children. */
  folder: boolean;
  collapsed: boolean;
  /** Edit group: lanes in one group move, split and trim together (0: none). */
  group: number;
  clips: AudioClip[];
}

/** Mirrors `AudioBus`: a bus that lane sends feed (a reverb or delay return). */
export interface AudioBus {
  id: string;
  name: string;
  volume: number;
  mute: boolean;
  effects: EffectSlot[];
}

/** Ripple editing: moving or deleting a clip moves the later ones. */
export type RippleMode = "off" | "lane" | "all";

/** The audio side of a song (settings version 3). */
export interface AudioLanesSettings {
  lanes: AudioLane[];
  sources: AudioSource[];
  buses: AudioBus[];
  /** Song-wide sync points: bar (0-based) to audio timeline ms. */
  sync: SyncPoint[];
  /** The play zone brackets, in bars (end null: the end of the song). */
  zone: { start: number; end: number | null };
  ripple: RippleMode;
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

/** Mirrors `MonitorParams` in `src-tauri/src/audio/monitor.rs`: how the monitor track plays. */
export interface MonitorParams {
  /** Listening to the input (off: the input is closed). */
  enabled: boolean;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  eq: TrackEq;
}

/**
 * Mirrors `MonitorTrack` in `src-tauri/src/mixer.rs`: the monitor track of a song. It plays the
 * audio input (Settings › Audio) live, through its own effect chain.
 */
export interface MonitorTrackSettings extends MonitorParams {
  effects: EffectSlot[];
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
  /** The old single audio track (settings version 1 and 2): read once and turned into a lane. */
  audioTrack?: AudioTrackSettings;
  /** Audio lanes, clips and sources (settings version 3). */
  audio?: AudioLanesSettings;
  /** The monitor track: the audio input, played live. */
  monitor?: MonitorTrackSettings;
  /** Effect chain presets saved with the song. */
  presets?: SongPreset[];
  /** Drum notes on a chosen line of the drum tab (#53). Mirrors `DrumLine` in `mixer.rs`. */
  drumLines?: DrumLine[];
  /** The tracks stacked in the continuous view (score indexes in display order; missing: only the shown one; #157). */
  visibleTracks?: number[];
  /** The track being edited when several are stacked (restored with them; #157). */
  activeTrack?: number;
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
  savePicks.pending += 1;
  try {
    const path = await saveDialog({ title, defaultPath, filters });
    savePicks.cancelled = path === null;
    return path;
  } finally {
    savePicks.pending -= 1;
    savePicks.settled += 1;
  }
}

/**
 * What the native Save dialog is doing, for code that waits for a save it started: `pending`
 * is how many are open, `settled` counts the closed ones, `cancelled` is whether the last one
 * was cancelled.
 */
export const savePicks = { pending: 0, settled: 0, cancelled: false };

/**
 * Writes a song or export to `path` (atomically). Rejects with a {@link CommandError}.
 * With `expectedHash` (from {@link scoreFileStamp}) the write is refused when the file on disk
 * changed since, so a synced cloud copy edited elsewhere is never overwritten unseen.
 */
export async function writeScoreFile(
  path: string,
  bytes: Uint8Array,
  expectedHash?: string,
): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  // The bytes are the raw request body; the path travels in a header.
  const headers: Record<string, string> = { path: encodeURIComponent(path) };
  if (expectedHash !== undefined) headers["expected-hash"] = expectedHash;
  await invoke<void>("write_score_file", bytes, { headers });
}

/** A song in the linked cloud folder (field names as the Rust side serializes them). */
export type CloudScore = {
  name: string;
  path: string;
  size: number;
  modified_ms: number;
  /** Not downloaded to this computer yet (a cloud-only placeholder). */
  placeholder: boolean;
};

/** A synced cloud folder found on this computer. */
export type CloudFolderCandidate = { provider: string; path: string };

/** The linked cloud folder, or `null` when none is linked (always `null` in a browser). */
export async function getCloudFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("get_cloud_folder");
}

/** Links `folder` as the cloud folder, or unlinks with `null`. Resolves to the stored folder. */
export async function setCloudFolder(folder: string | null): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<string | null>("set_cloud_folder", { folder });
}

/** Synced folders (iCloud Drive, Dropbox, ...) found on this computer. Empty in a browser. */
export async function detectCloudFolders(): Promise<CloudFolderCandidate[]> {
  if (!isTauri()) return [];
  return invoke<CloudFolderCandidate[]>("detect_cloud_folders");
}

/** The songs in the linked cloud folder. Empty in a browser. */
export async function listCloudScores(): Promise<CloudScore[]> {
  if (!isTauri()) return [];
  return invoke<CloudScore[]>("list_cloud_scores");
}

/** A saved separation (`.sbstems`) in the linked cloud folder; the same shape as a song. */
export type CloudStem = CloudScore;

/** The `.sbstems` files in the linked cloud folder, newest first. Empty in a browser. */
export async function listCloudStems(): Promise<CloudStem[]> {
  if (!isTauri()) return [];
  return invoke<CloudStem[]>("list_cloud_stems");
}

/** Native folder dialog for the cloud folder. Resolves to the path, or `null` if cancelled. */
export async function pickCloudFolder(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({ title: "Choose your cloud folder", multiple: false, directory: true });
}

/** When the file at `path` last changed and its content hash; `null` if it does not exist. */
export async function scoreFileStamp(
  path: string,
): Promise<{ modified_ms: number; hash: string } | null> {
  if (!isTauri()) return null;
  return invoke<{ modified_ms: number; hash: string } | null>("score_file_stamp", { path });
}

/**
 * Encodes rendered audio (the bytes of a 16-bit WAV file) as AAC and writes it
 * to the `.m4a` file `path`, with the operating system's own encoder. Rejects
 * with a {@link CommandError}; macOS and Windows have one (see {@link canExportM4a}).
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
export const canExportM4a = ({ os }: Pick<AppInfo, "os">) => os === "macos" || os === "windows";

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

/**
 * Subscribes to songs the system asks Smart Beat to open (double-click in Finder or Explorer,
 * "Open With"). The event only says that files are waiting: `handler` is called with the
 * waiting paths, so a file that arrived before the page was ready is not lost.
 */
export async function onOpenExternalFiles(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  const drain = () =>
    invoke<string[]>("take_pending_open_files").then((paths) => {
      if (paths.length > 0) handler(paths);
    }, console.error);
  const stop = await listen(OPEN_EXTERNAL_FILE_EVENT, drain);
  await drain();
  return stop;
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
 * Stores mixer settings inside a `.gp` file that was just written, with every embedded audio
 * file a clip plays (files no clip plays any more are dropped).
 */
export const writeProjectSettings = (path: string, settings: MixerSettings) =>
  call<void>("write_project_settings", { path, settings });

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
  /** Each audio lane after its fader: (lane id, level). */
  lanes?: [string, number][];
  /** The monitor track, after its effects and fader. */
  monitor?: number;
  /** The audio input of the monitor track, before its effects. */
  monitorInput?: number;
  /** Gain reduction (dB) of each pedalboard slot's compressor or limiter (#39). */
  reduction?: { tracks: number[][]; master: number[]; monitor?: number[] };
}

/** Mirrors `MonitorStatus` in `src-tauri/src/audio/mod.rs`: the monitor track's input. */
export interface MonitorStatus {
  /** Listening now. */
  open: boolean;
  /** The input's name as the system gives it. */
  device: string;
  channels: number;
  sampleRate: number;
  /** From the input to the output, estimated. */
  latencyMs: number;
  /** Why the input is not open, or why it stopped. */
  error: string | null;
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

/** Mirrors `SourceLocation`: where an audio file for a lane comes from. */
export type SourceLocation =
  { type: "file"; path: string } | { type: "embedded"; scorePath: string; entry: string };

/** Mirrors `SourceInfo`: what the engine learnt about an audio file. */
export interface SourceInfo {
  /** SHA-256 of the file: the id clips use. */
  id: string;
  name: string;
  ext: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Loudest sample per 1/`peaksPerSecond` s (0…1). */
  peaks: number[];
  peaksPerSecond: number;
}

/** Mirrors `BeatInfo`: a detected tempo and where its beats fall in the file (ms). */
export interface BeatInfo {
  bpm: number;
  beats: number[];
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
  /** The monitor track's input (null: no monitor track). */
  monitor?: MonitorStatus | null;
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
  /** The sound of metronome and count-in clicks (#182). */
  | { type: "clickSound"; sound: "classic" | "woodblock" | "cowbell" | "bell" }
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

/** Opens an audio file for the lanes (decoded once, identified by its content hash). */
export const loadAudioSource = (location: SourceLocation) =>
  call<SourceInfo>("audio_load_source", { location });

/** Adds a recorded take (a WAV file) to the lanes' audio files. */
export async function addAudioTake(name: string, wav: Uint8Array): Promise<SourceInfo> {
  if (!isTauri()) throw new Error("Recording needs the desktop app");
  return invoke<SourceInfo>("audio_add_take", wav, { headers: { "x-name": name } });
}

/** Lets go of every loaded audio file not listed in `keep`. */
export const forgetAudioSources = (keep: string[]) => call<void>("audio_forget_sources", { keep });

/** The lanes as the engine plays them (`null`: none); `sync` in score ticks. */
export interface EngineLanes {
  audio: AudioLanesSettings;
  sync: { tick: number; ms: number }[];
  /** Song transposition in semitones. */
  transpose: number;
}
export const setEngineLanes = (lanes: EngineLanes | null) =>
  call<void>("audio_set_lanes", { lanes });

/** The nearest zero crossing to `ms` in a loaded file (within 10 ms). */
export const audioZeroCrossing = (source: string, ms: number) =>
  call<number>("audio_zero_crossing", { source, ms });

/** Saves a loaded audio file: its original bytes, or a 16-bit WAV. */
export const extractAudioSource = (source: string, path: string, asWav: boolean) =>
  call<void>("audio_extract_source", { source, path, asWav });

/** A spectrogram of part of a file: `columns` × `bins` magnitudes in dB (−100 … 0). */
export const audioSpectrogram = (
  source: string,
  startMs: number,
  endMs: number,
  columns: number,
  bins: number,
) => call<number[][]>("audio_spectrogram", { source, startMs, endMs, columns, bins });

/** The tempo of a file and where its beats fall. */
export const detectAudioBeats = (source: string) =>
  call<BeatInfo>("audio_detect_beats", { source });

/**
 * The monitor track (null removes it): its settings, and the input it plays. `device` is the
 * input's name (null: the system's default input); `channel` is 0-based (null: all mixed).
 */
export const setEngineMonitor = (
  monitor: { params: MonitorParams; device: string | null; channel: number | null } | null,
) => call<MonitorStatus | null>("audio_set_monitor", { monitor });

/** The monitor track's effect chain. Resolves to the blocks that cannot run. */
export const setEngineMonitorChain = (slots: EffectSlot[]) =>
  call<BlockProblem[]>("audio_set_monitor_chain", { slots });

/** How many channels an input has (null: the system's default input). */
export const engineInputChannels = (device: string | null) =>
  call<number>("audio_input_channels", { device });

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

// --- Extra SoundFonts (#81) --------------------------------------------------

/** Mirrors `SoundFontInfo` in `src-tauri/src/audio/soundfonts.rs`. */
export interface StoredSoundFont {
  id: string;
  name: string;
  file: string;
  bytes: number;
  /** The catalogue bank it was downloaded as (none: imported from the user's files). */
  catalogue: string | null;
}

/** Mirrors `CatalogueItem` in `src-tauri/src/audio/soundfonts.rs`. */
export interface SoundFontCatalogueItem {
  id: string;
  name: string;
  description: string;
  licence: string;
  personalUseOnly: boolean;
  page: string;
  /** What is downloaded, in bytes. */
  downloadBytes: number;
  /** Its size on disk once installed. */
  bytes: number;
  installed: boolean;
}

export const listStoredSoundFonts = () => call<StoredSoundFont[]>("soundfonts_list");
export const soundFontCatalogue = () => call<SoundFontCatalogueItem[]>("soundfonts_catalogue");
export const importStoredSoundFont = (path: string) =>
  call<StoredSoundFont>("soundfonts_import", { path });
export const removeStoredSoundFont = (id: string) => call<void>("soundfonts_remove", { id });
export const cancelSoundFontDownload = () => call<void>("soundfonts_cancel_download");
/** Loads a stored SoundFont in the audio engine from its file; resolves to its engine id. */
export const activateStoredSoundFont = (id: string) => call<string>("soundfonts_activate", { id });

/** The bytes of a stored SoundFont, for the alphaTab synthesizer. */
export async function readStoredSoundFont(id: string): Promise<Uint8Array> {
  // The Rust command answers with raw bytes, which arrive as an ArrayBuffer.
  return new Uint8Array(await call<ArrayBuffer>("soundfonts_read", { id }));
}

/** The error text of a download the user stopped. */
export const SOUNDFONT_DOWNLOAD_CANCELLED = "cancelled";

const SOUNDFONT_PROGRESS_EVENT = "soundfont-download-progress";

export interface SoundFontDownloadProgress {
  id: string;
  /** 0…1 while downloading. */
  fraction: number;
  /** The download is done and the file is being unpacked. */
  unpacking: boolean;
}

/** Downloads a catalogue bank (checked and unpacked by the app). `onProgress` reports the steps. */
export async function downloadCatalogueSoundFont(
  id: string,
  onProgress?: (progress: SoundFontDownloadProgress) => void,
): Promise<StoredSoundFont> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<SoundFontDownloadProgress>(SOUNDFONT_PROGRESS_EVENT, (event) => {
        if (event.payload.id === id) onProgress(event.payload);
      })
    : () => {};
  try {
    return await invoke<StoredSoundFont>("soundfonts_download", { id });
  } finally {
    stopListening();
  }
}

/** Native Open dialog for a SoundFont. */
export async function pickSoundFontFile(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: "Import a SoundFont",
    multiple: false,
    directory: false,
    filters: [{ name: "SoundFonts", extensions: ["sf2", "sf3"] }],
  });
}

// --- Record to tab -----------------------------------------------------------

const RECORDING_PROGRESS_EVENT = "recording-transcription-progress";

/** What Rust says when {@link cancelRecordingTranscription} stopped the running transcription. */
export const RECORDING_STOPPED = "Transcription stopped.";

/** True for the error of a transcription that was stopped on purpose. */
export const isRecordingStopped = (error: unknown): boolean =>
  (typeof error === "string" ? error : (error as { message?: unknown } | null)?.message) ===
  RECORDING_STOPPED;

/**
 * Turns a take (mono samples as 32-bit floats) into notes, on this computer. `onProgress` gets
 * the fraction done (0…1). A piano uses stricter note settings than the default, and drums go through the hit finder (the notes are General MIDI drum numbers). Rejects with {@link RECORDING_STOPPED} after a cancel.
 */
export async function transcribeRecording(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
  instrument: "guitar" | "piano" | "drums" = "guitar",
  engine: "standard" | "accurate" | "muscriptor" = "standard",
  modelSize: MuscriptorSize = "medium",
): Promise<RecordedNote[]> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<{ fraction: number }>(RECORDING_PROGRESS_EVENT, (event) =>
        onProgress(event.payload.fraction),
      )
    : () => {};
  try {
    // The samples are the raw request body (little-endian f32); the rate travels in a header.
    const body = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const result = await invoke<{ notes: RecordedNote[] }>("transcribe_recording", body, {
      headers: {
        "x-sample-rate": String(sampleRate),
        "x-instrument": instrument,
        ...(instrument === "piano" && engine === "accurate" ? { "x-engine": "transkun" } : {}),
        ...(engine === "muscriptor" ? { "x-engine": "muscriptor", "x-model-size": modelSize } : {}),
      },
    });
    return result.notes;
  } finally {
    stopListening();
  }
}

/** The bytes of an audio file dropped on the window (MP3, WAV, FLAC or OGG, up to 100 MiB). */
export async function readDroppedAudio(path: string): Promise<ArrayBuffer> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<ArrayBuffer>("read_transcription_audio", { path });
}

const PIANO_MODEL_PROGRESS_EVENT = "piano-model-download-progress";

/** Mirrors `PianoModelStatus` in `src-tauri/src/recording/piano_model.rs`. */
export interface PianoModelStatus {
  installed: boolean;
  /** The size of the download. */
  bytes: number;
}

/** Whether the high-accuracy piano model is on this computer, and what its download is. */
export async function pianoModelStatus(): Promise<PianoModelStatus> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<PianoModelStatus>("piano_model_status");
}

/**
 * Downloads the high-accuracy piano model, once, and checks it. `onProgress` gets the fraction
 * done (0…1).
 */
export async function downloadPianoModel(onProgress?: (fraction: number) => void): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<{ fraction: number }>(PIANO_MODEL_PROGRESS_EVENT, (event) =>
        onProgress(event.payload.fraction),
      )
    : () => {};
  try {
    await invoke<void>("download_piano_model");
  } finally {
    stopListening();
  }
}

/** Deletes the downloaded high-accuracy piano model (about 55 MB). Refused while it downloads. */
export async function removePianoModel(): Promise<PianoModelStatus> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<PianoModelStatus>("piano_model_remove");
}

// --- MuScriptor, the optional AI model (#150) --------------------------------

const MUSCRIPTOR_PROGRESS_EVENT = "muscriptor-model-download-progress";

export type MuscriptorSize = "small" | "medium" | "large";

/** Mirrors `Status` in `src-tauri/src/recording/muscriptor_model.rs`. */
export interface MuscriptorStatus {
  /** The engine is built into this app. It is not on Linux. */
  supported: boolean;
  termsVersion: number;
  sizes: {
    size: MuscriptorSize;
    /** The size of the download. */
    bytes: number;
    installed: boolean;
    /** The user accepted the terms of this size and confirmed their rights to the music. */
    termsAccepted: boolean;
    /** Bytes of an interrupted download that the next one continues from. */
    partialBytes: number;
  }[];
}

/** Which MuScriptor sizes are on this computer, and whether the terms were accepted. */
export async function muscriptorStatus(): Promise<MuscriptorStatus> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<MuscriptorStatus>("muscriptor_status");
}

/** Records the acceptance of the terms of one size. Rejects unless the rights are confirmed. */
export async function acceptMuscriptorTerms(
  size: MuscriptorSize,
  rightsConfirmed: boolean,
): Promise<MuscriptorStatus> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<MuscriptorStatus>("accept_muscriptor_terms", { size, rightsConfirmed });
}

/**
 * Downloads a MuScriptor size, continuing an interrupted download. `onProgress` gets the fraction
 * done (0…1). Rejects with "Download stopped." after {@link cancelMuscriptorDownload}.
 */
export async function downloadMuscriptorModel(
  size: MuscriptorSize,
  onProgress?: (fraction: number, bytes: number) => void,
): Promise<MuscriptorStatus> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<{ size: MuscriptorSize; fraction: number; bytes: number }>(
        MUSCRIPTOR_PROGRESS_EVENT,
        (event) => {
          if (event.payload.size === size) onProgress(event.payload.fraction, event.payload.bytes);
        },
      )
    : () => {};
  try {
    return await invoke<MuscriptorStatus>("download_muscriptor_model", { size });
  } finally {
    stopListening();
  }
}

/** Stops the running download; the part saved so far is kept. */
export async function cancelMuscriptorDownload(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("cancel_muscriptor_download");
}

/** Deletes a downloaded size. */
export async function deleteMuscriptorModel(size: MuscriptorSize): Promise<MuscriptorStatus> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return invoke<MuscriptorStatus>("delete_muscriptor_model", { size });
}

/** Stops the running {@link transcribeRecording}, which then rejects. */
export async function cancelRecordingTranscription(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("cancel_recording_transcription");
}

// --- Third-party plugins: VST3 and CLAP (#80) -------------------------------

/** Mirrors `PluginFormat` in `src-tauri/src/audio/plugin.rs`. */
export type NativePluginFormat = "vst3" | "clap";

/** Mirrors `ScannedPlugin` in `src-tauri/src/audio/plugin.rs`. */
export interface ScannedPlugin {
  format: NativePluginFormat;
  path: string;
  name: string;
  vendor: string;
  version: string;
  hasGui: boolean;
}

/** Mirrors `PluginScanReport` in `src-tauri/src/audio/plugin.rs`. */
export interface PluginScanReport {
  plugins: ScannedPlugin[];
  /** Installed files that could not be loaded (one line each). */
  skipped: string[];
}

/** Mirrors `PluginSlotInfo` in `src-tauri/src/audio/plugin.rs`. */
export interface PluginSlotInfo {
  index: number;
  name: string;
  latencySamples: number;
  /** Added latency in milliseconds (what the UI shows). */
  latencyMs: number;
  alive: boolean;
  loading: boolean;
  /** The last failure in plain words (empty while healthy). */
  error: string;
}

/** Lists the installed VST3 and CLAP plugins (each probed in isolation). */
export const scanPlugins = () => call<PluginScanReport>("plugins_scan");

/** Switches third-party plugin blocks on or off (off by default). */
export const setPluginsEnabled = (enabled: boolean) =>
  call<void>("plugins_set_enabled", { enabled });

export const getPluginsEnabled = () => call<boolean>("plugins_enabled");

/**
 * Opens the plugin's own editor window (owned by the helper process).
 * Resolves to the editor size in pixels.
 */
export const openPluginEditor = (track: number | "monitor" | null, sound: number, index: number) =>
  call<[number, number]>("plugin_open_editor", { track, sound, index });

export const closePluginEditor = (track: number | "monitor" | null, sound: number, index: number) =>
  call<void>("plugin_close_editor", { track, sound, index });

/** Saves the plugin's current settings as base64 (stored in the block). */
export const savePluginState = (track: number | "monitor" | null, sound: number, index: number) =>
  call<string>("plugin_save_state", { track, sound, index });

/** Live status of every plugin block of a chain. */
export const pluginInfo = (track: number | "monitor" | null, sound: number) =>
  call<PluginSlotInfo[]>("audio_plugin_info", { track, sound });

// --- Practice together -------------------------------------------------------

/** Mirrors `LinkState` in `src-tauri/src/practice.rs`. */
export type PracticeLinkState = "connecting" | "open" | "reconnecting" | "closed";

/** Mirrors `HostInfo` in `src-tauri/src/practice.rs`: what the host shows its guest. */
export interface PracticeHostInfo {
  /** The room code to read out, like `ABCD-EFGH-JKMN-PQRS-TVWX`. */
  code: string;
  /** The same code as a `smartbeat://join/…` link. Reserved: no such link is registered or opened yet. */
  link: string;
  /** The address the code stands for (shown so a firewall problem can be found). */
  address: string;
}

const PRACTICE_FRAME_EVENT = "practice-frame";
const PRACTICE_STATE_EVENT = "practice-state";

/** Starts listening for a guest on the local network. */
export const practiceHost = () => call<PracticeHostInfo>("practice_host");

/** Joins a host by its room code. */
export const practiceJoin = (code: string) => call<void>("practice_join", { code });

/**
 * Sends one frame to the other app. A host names the guest's connection (`conn`, as it heard
 * it in `onPracticeFrame`). False when there is no connection right now.
 */
export const practiceSend = (text: string, conn?: number) =>
  call<boolean>("practice_send", { text, conn: conn ?? null });

/** The host ends one guest's connection. With `ban`, that guest's address is turned away too. */
export const practiceKick = (conn: number, ban: boolean) =>
  call<void>("practice_kick", { conn, ban });

/** Ends the session. */
export const practiceLeave = () => call<void>("practice_leave");

/**
 * Frames from the other app. `conn` says which connection it came on: a host has one per guest,
 * a guest one. Resolves to an unsubscribe function.
 */
export async function onPracticeFrame(
  handler: (text: string, conn: number) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ conn: number; text: string }>(PRACTICE_FRAME_EVENT, (event) =>
    handler(event.payload.text, event.payload.conn),
  );
}

/**
 * A connection going up or down (`conn` 0 is the link itself). A host's new connection says
 * where the guest is in `detail`. Resolves to an unsubscribe function.
 */
export async function onPracticeState(
  handler: (state: PracticeLinkState, detail: string | undefined, conn: number) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ conn: number; state: PracticeLinkState; detail: string | null }>(
    PRACTICE_STATE_EVENT,
    (event) => handler(event.payload.state, event.payload.detail ?? undefined, event.payload.conn),
  );
}

const PRACTICE_SIGNAL_EVENT = "practice-signal";
const PRACTICE_SIGNAL_FAILED_EVENT = "practice-signal-failed";

/** Whether this build can meet another player over the internet (it knows a signaling Worker). */
export const practiceSignalAvailable = () =>
  isTauri() ? call<boolean>("practice_signal_available") : Promise.resolve(false);

/** Makes a meeting room for Practice together over the internet. Returns its code. */
export const practiceSignalCreate = () => call<string>("practice_signal_create");

/**
 * Joins a meeting room by its code. `guest` is this app's stable id: with it the app takes its
 * old place after it dropped out, and the host can ban it.
 */
export const practiceSignalJoin = (code: string, guest?: string) =>
  call<void>("practice_signal_join", { code, guest: guest ?? null });

/**
 * Hands a setup message (a WebRTC offer, answer or candidate) to the other app. A host names
 * the guest (`to`, as it heard it in `onPracticeSignal`).
 */
export const practiceSignalSend = (text: string, to?: string) =>
  call<void>("practice_signal_send", { text, to: to ?? null });

/** The host removes a guest from the meeting room; with `ban`, its id can never come back. */
export const practiceSignalKick = (peer: string, ban: boolean) =>
  call<void>("practice_signal_kick", { peer, ban });

/** Leaves the meeting room. */
export const practiceSignalLeave = () => call<void>("practice_signal_leave");

/**
 * Setup messages from the other app. A host hears which guest wrote it (`from`). Resolves to an
 * unsubscribe function.
 */
export async function onPracticeSignal(
  handler: (text: string, from?: string) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ from: string | null; text: string }>(PRACTICE_SIGNAL_EVENT, (event) =>
    handler(event.payload.text, event.payload.from ?? undefined),
  );
}

/** The meeting room closed or could not be reached. Resolves to an unsubscribe function. */
export async function onPracticeSignalFailed(handler: (why: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<string>(PRACTICE_SIGNAL_FAILED_EVENT, (event) => handler(event.payload));
}

// --- Stem separation (#186) --------------------------------------------------

const STEMS_PROGRESS_EVENT = "stems-progress";
const UMX_PROGRESS_EVENT = "umx-model-download-progress";
const STEM_MODEL_PROGRESS_EVENT = "stem-model-download-progress";
const STEMS_BUNDLE_PROGRESS_EVENT = "stems-bundle-progress";
/** Mirrors `BUNDLE_OPENED_EVENT` in `src-tauri/src/stems`: the system opened a `.sbstems` file. */
export const STEMS_BUNDLE_OPENED_EVENT = "stems-bundle-opened";

/**
 * The parts a song is split into, in the order the page lists them. Mirrors `StemKind`. Guitar and
 * piano exist only in songs made by the 6-source engine (`htdemucs-6s`).
 */
export const STEM_KINDS = [
  "drums",
  "bass",
  "vocals",
  "guitar",
  "piano",
  "panned",
  "other",
] as const;
export type StemKindId = (typeof STEM_KINDS)[number];

/**
 * Fast is signal processing and built in. The others are optional downloaded models: `neural` is
 * Open-Unmix UMX-HQ (the first one offered, so its id stayed), then SCNet Small, SCNet XL and
 * HTDemucs and its 6-source variant (adds guitar and piano). Mirrors `StemEngine` in
 * `src-tauri/src/stems/mod.rs`.
 */
export type StemEngine = "fast" | "neural" | "scnet" | "scnet-xl" | "htdemucs" | "htdemucs-6s";

/** Mirrors `SeparateRequest` in `src-tauri/src/stems/mod.rs`. */
export interface SeparateRequest {
  path: string;
  /** The parts to pull out; "other" is always made. The neural engines ignore this and `strongDrums`. */
  kinds: StemKindId[];
  engine: StemEngine;
  strongDrums: boolean;
}

export interface StemInfo {
  kind: StemKindId;
  bytes: number;
}

/** A separated song in the library (`<app data>/stems/<id>/`). */
export interface StemSong {
  id: string;
  /** The file's name without its extension. */
  name: string;
  durationSeconds: number;
  sampleRate: number;
  engine: StemEngine;
  strongDrums: boolean;
  stems: StemInfo[];
  /** The file was mono: vocals and panned parts cannot be told apart. */
  mono: boolean;
  /** Parts that were asked for but could not be separated. */
  skipped: StemKindId[];
  /** How much of the song sits hard to one side (0 to 1). */
  pannedShare: number;
  bytes: number;
  createdAtMs: number;
  /** Kept at the top of the library: the size limit never removes it. */
  pinned: boolean;
  /** When the song was last opened, in milliseconds (null: never since it was made). */
  lastOpened: number | null;
  /** Where the song was last saved as a `.sbstems` file (null: never saved). */
  savedPath: string | null;
  /** The original song is available to add to a saved file. */
  hasOriginal: boolean;
}

export type StemStage = "reading" | "separating" | "saving" | "done";

export interface StemProgress {
  stage: StemStage;
  /** 0 to 1 within the stage. */
  fraction: number;
}

export interface StemCacheInfo {
  bytes: number;
  count: number;
  limitBytes: number;
}

/** What Rust says when {@link cancelStemSeparation} stopped the running job (`separation::STOPPED`). */
export const STEMS_STOPPED = "Stem separation stopped.";

/** True for the error of a separation that was stopped on purpose. */
export const isStemsStopped = (error: unknown): boolean =>
  (typeof error === "string" ? error : (error as { message?: unknown } | null)?.message) ===
  STEMS_STOPPED;

/** Native Open dialog for the song to separate. */
export async function pickStemFile(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: "Choose a song to separate",
    multiple: false,
    directory: false,
    filters: [{ name: "Audio files", extensions: [...AUDIO_EXTENSIONS] }],
  });
}

/**
 * Splits a song into stems on this computer. `onProgress` gets each stage and the fraction done
 * in it. Rejects with {@link STEMS_STOPPED} after {@link cancelStemSeparation}. Separating the
 * same file with the same options again returns the saved song at once.
 */
export async function separateStems(
  request: SeparateRequest,
  onProgress?: (progress: StemProgress) => void,
): Promise<StemSong> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<StemProgress>(STEMS_PROGRESS_EVENT, (event) => onProgress(event.payload))
    : () => {};
  try {
    return await invoke<StemSong>("stems_separate", { request });
  } finally {
    stopListening();
  }
}

/** Stops the running {@link separateStems}, which then rejects. */
export async function cancelStemSeparation(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("stems_cancel");
}

/** The separated songs, newest first. */
export const listStemSongs = () => call<StemSong[]>("stems_list");

export const stemCacheInfo = () => call<StemCacheInfo>("stems_cache_info");

export const deleteStemSong = (id: string) => call<void>("stems_delete", { id });

/** Deletes every separated song. Resolves to the bytes freed. */
export const clearStemSongs = () => call<number>("stems_clear");

/** Marks the song as just opened, so the start screen lists it first. */
export const touchStemSong = (id: string) => call<void>("stems_touch", { id });

/** Keeps (or stops keeping) the song out of the library's size limit. */
export const pinStemSong = (id: string, pinned: boolean) => call<void>("stems_pin", { id, pinned });

/** The extension of a saved separation, and the name the file dialogs give it. */
export const STEMS_BUNDLE_EXTENSION = "sbstems";
export const STEMS_BUNDLE_TYPE_NAME = "Smart Beat stems";

/** Mirrors `SaveBundleRequest` in `src-tauri/src/stems`. */
export interface SaveBundleRequest {
  id: string;
  /** The file to write, ending in `.sbstems`. */
  dest: string;
  /** Add the song itself, so the file works on its own. */
  includeOriginal: boolean;
}

export interface SaveBundleResult {
  path: string;
  bytes: number;
  /** False when the original was asked for but could not be added. */
  originalIncluded: boolean;
}

export interface BundleProgress {
  /**
   * Writing and reading are the file on this computer; a save to an account also uploads it, and
   * an open from one downloads it first.
   */
  stage: "writing" | "reading" | "uploading" | "downloading";
  /** 0 to 1 within the stage. */
  fraction: number;
}

/** Native Save dialog for a separated song; resolves to the path, or `null` if cancelled. */
export async function pickStemBundleDestination(defaultName: string): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return saveDialog({
    title: "Save stems",
    defaultPath: `${defaultName}.${STEMS_BUNDLE_EXTENSION}`,
    filters: [{ name: STEMS_BUNDLE_TYPE_NAME, extensions: [STEMS_BUNDLE_EXTENSION] }],
  });
}

/**
 * Where a song called `name` is saved inside the linked cloud folder (a clean file name, numbered
 * if it exists). Rejects with kind "not-found" when no folder is linked or it is gone.
 */
export const stemsCloudSavePath = (name: string) => call<string>("stems_cloud_save_path", { name });

/** About how big the `.sbstems` file of a song will be (an estimate), in bytes. */
export const estimateStemBundle = (id: string, includeOriginal: boolean) =>
  call<{ bytes: number }>("stems_estimate_bundle", { id, includeOriginal });

/** Native Open dialog for a saved separation; resolves to the path, or `null` if cancelled. */
export async function pickStemBundle(): Promise<string | null> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return openDialog({
    title: "Open saved stems",
    multiple: false,
    directory: false,
    filters: [{ name: STEMS_BUNDLE_TYPE_NAME, extensions: [STEMS_BUNDLE_EXTENSION] }],
  });
}

/** Runs `job` while the bundle progress events go to `onProgress`. */
async function withBundleProgress<T>(
  onProgress: ((progress: BundleProgress) => void) | undefined,
  job: () => Promise<T>,
): Promise<T> {
  const stopListening = onProgress
    ? await listen<BundleProgress>(STEMS_BUNDLE_PROGRESS_EVENT, (event) =>
        onProgress(event.payload),
      )
    : () => {};
  try {
    return await job();
  } finally {
    stopListening();
  }
}

/** Writes a separated song to a `.sbstems` file, with or without the original song. */
export async function saveStemBundle(
  request: SaveBundleRequest,
  onProgress?: (progress: BundleProgress) => void,
): Promise<SaveBundleResult> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return withBundleProgress(onProgress, () =>
    invoke<SaveBundleResult>("stems_save_bundle", { request }),
  );
}

/** Reads a `.sbstems` file into the library and returns its song. */
export async function openStemBundle(
  path: string,
  onProgress?: (progress: BundleProgress) => void,
): Promise<StemSong> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return withBundleProgress(onProgress, () => invoke<StemSong>("stems_open_bundle", { path }));
}

/** The cloud services the stems can be saved to, as in `CloudProvider` of `@/lib/cloud`. */
export type StemCloudProvider = "drive" | "onedrive" | "dropbox";

/** A `.sbstems` file in a connected account (Rust `RemoteFile`). `id` is the item id (`drive:<id>`). */
export interface CloudStemFile {
  id: string;
  name: string;
  revision: string;
  size: number;
  modified_ms: number;
}

/** Mirrors `StemCloudSaveRequest` in `src-tauri/src/stems`. */
export interface StemCloudSaveRequest {
  /** The song in the library. */
  id: string;
  provider: StemCloudProvider;
  /** Add the song itself, so the file works on its own. */
  includeOriginal: boolean;
}

/** What a save to an account answers; `item` is its item id (`drive:<id>`). */
export interface StemCloudSaveResult {
  item: string;
  /** The file name the service has, `<song>.sbstems`. */
  name: string;
  provider: StemCloudProvider;
  bytes: number;
  /** False when the original was asked for but could not be added. */
  originalIncluded: boolean;
}

/** Mirrors `STOPPED` in `src-tauri/src/stems/bundle.rs`: what a save or open ends with after Cancel. */
const STEM_FILE_STOPPED = "Stem file stopped.";

/** The error of a save or open that the person stopped, which is not a failure to report. */
export const isStemFileStopped = (error: unknown) =>
  isCommandError(error) && error.message === STEM_FILE_STOPPED;

/** The saved stems (`.sbstems` files only) in a connected account's Smart Beat folder, newest first. */
export const listCloudStemFiles = (provider: StemCloudProvider) =>
  call<CloudStemFile[]>("cloud_list_stems", { provider });

/**
 * Saves a separated song into a connected account: the file is written here, then uploaded.
 * Progress is `writing` (making the file) and then `uploading`. `cancelStemSeparation` stops it.
 */
export async function saveStemBundleToCloud(
  request: StemCloudSaveRequest,
  onProgress?: (progress: BundleProgress) => void,
): Promise<StemCloudSaveResult> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return withBundleProgress(onProgress, () =>
    invoke<StemCloudSaveResult>("stems_cloud_save", { request }),
  );
}

/**
 * Opens a `.sbstems` file of a connected account: downloaded, then read into the library. Progress
 * is `downloading` and then `reading`. `cancelStemSeparation` stops it.
 */
export async function openStemBundleFromCloud(
  item: string,
  onProgress?: (progress: BundleProgress) => void,
): Promise<StemSong> {
  if (!isTauri()) throw new NotInDesktopAppError();
  return withBundleProgress(onProgress, () =>
    invoke<StemSong>("stems_cloud_open", { request: { item } }),
  );
}

/**
 * Subscribes to `.sbstems` files the system asks the app to open (double-click in Finder or
 * Explorer). Resolves to an unsubscribe function; in a browser there is nothing to listen to.
 */
export async function onStemBundleOpened(handler: (path: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  const unlisten = await listen<{ path: string }>(STEMS_BUNDLE_OPENED_EVENT, (event) =>
    handler(event.payload.path),
  );
  // Files that arrived before this listener (a double-click that launched the app) are queued
  // in Rust. Asking for them after listening also tells Rust to send later ones as events.
  try {
    const waiting = await invoke<string[]>("take_pending_stem_bundles");
    waiting.forEach(handler);
  } catch (cause) {
    console.error(cause);
  }
  return unlisten;
}

/** Shows a file in Finder or Explorer. */
export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  await revealItemInDir(path);
}

/** The WAV file of one stem (16-bit stereo). */
export async function readStem(id: string, kind: StemKindId): Promise<ArrayBuffer> {
  return call<ArrayBuffer>("stems_read", { id, kind });
}

/**
 * The stems added up with `gains` (0 to 1 each, mute and solo already applied), slowed to
 * `speed` (0.5 to 1) without changing the pitch, as a WAV file.
 */
export async function renderStemMix(
  id: string,
  gains: Partial<Record<StemKindId, number>>,
  speed: number,
): Promise<ArrayBuffer> {
  return call<ArrayBuffer>("stems_render_mix", { id, request: { gains, speed } });
}

/** Mirrors `Tempo` in `src-tauri/src/separation/tempo.rs`. */
export interface StemTempo {
  /** Beats per minute; 0 when there is nothing to measure (silence, a clip of a few seconds). */
  bpm: number;
  /** 0 to 1: how clearly the song pulses at that tempo. */
  confidence: number;
  /** The first grid beat at or after the start of the file, in seconds. */
  firstBeatSec: number;
  /** Other plausible tempos (half and double time, the next peaks), best first. */
  alternatives: number[];
  /** One tempo from start to end; a few BPM of drift still counts as steady. */
  steady: boolean;
  /** Large, lasting tempo changes covering the song from 0 to its end; empty when steady. */
  sections: { startSec: number; endSec: number; bpm: number }[];
}

/**
 * The tempo of a separated song (analysed once, then kept with the song). A `stems_cancel`
 * makes it fail with "Tempo detection stopped.".
 */
export const detectStemTempo = (id: string) => call<StemTempo>("stems_detect_tempo", { id });

/** Mirrors `UmxStatus` in `src-tauri/src/stems/umx_model.rs`. */
export interface UmxStatus {
  downloaded: boolean;
  termsAccepted: boolean;
  termsVersion: number;
  /** The size of the download. */
  downloadBytes: number;
  /** The licence wording the user confirms. */
  licence: string;
}

export interface UmxDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
}

export const umxModelStatus = () => call<UmxStatus>("umx_model_status");

/** Records that the user accepted the terms of the neural model. */
export const acceptUmxTerms = () => call<void>("umx_model_accept_terms");

/** Downloads the neural model. Rejects with "Download stopped." after {@link cancelUmxDownload}. */
export async function downloadUmxModel(
  onProgress?: (progress: UmxDownloadProgress) => void,
): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<UmxDownloadProgress>(UMX_PROGRESS_EVENT, (event) => onProgress(event.payload))
    : () => {};
  try {
    await invoke<void>("umx_model_download");
  } finally {
    stopListening();
  }
}

export async function cancelUmxDownload(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("umx_model_cancel");
}

export const removeUmxModel = () => call<void>("umx_model_remove");

// --- The SCNet and HTDemucs models (#186) ----------------------------------------------------

/** The downloadable models that share the `stem_model_*` commands (UMX-HQ has its own). */
export const STEM_MODELS = ["scnet", "scnet-xl", "htdemucs", "htdemucs-6s"] as const;
export type StemModelId = (typeof STEM_MODELS)[number];

/** Mirrors `ModelStatus` in `src-tauri/src/stems/models.rs`. */
export interface StemModelStatus {
  model: StemModelId;
  downloaded: boolean;
  termsAccepted: boolean;
  termsVersion: number;
  /** The size of the download, in bytes. */
  downloadBytes: number;
  /** The licence wording the user confirms. */
  licence: string;
  licenceSummary: string;
  /** False while the converted model file is not published yet: the download is not offered. */
  available: boolean;
}

export interface StemModelDownloadProgress {
  model: StemModelId;
  downloadedBytes: number;
  totalBytes: number;
}

export const stemModelStatus = (model: StemModelId) =>
  call<StemModelStatus>("stem_model_status", { model });

/** Records that the user accepted the terms of the model. */
export const acceptStemModelTerms = (model: StemModelId) =>
  call<void>("stem_model_accept_terms", { model });

/** Downloads a model. Rejects with "Download stopped." after {@link cancelStemModelDownload}. */
export async function downloadStemModel(
  model: StemModelId,
  onProgress?: (progress: StemModelDownloadProgress) => void,
): Promise<void> {
  if (!isTauri()) throw new NotInDesktopAppError();
  const stopListening = onProgress
    ? await listen<StemModelDownloadProgress>(STEM_MODEL_PROGRESS_EVENT, (event) => {
        if (event.payload.model === model) onProgress(event.payload);
      })
    : () => {};
  try {
    await invoke<void>("stem_model_download", { model });
  } finally {
    stopListening();
  }
}

export async function cancelStemModelDownload(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("stem_model_cancel");
}

export const removeStemModel = (model: StemModelId) => call<void>("stem_model_remove", { model });
