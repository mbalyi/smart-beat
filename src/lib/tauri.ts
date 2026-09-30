/**
 * Typed bridge to the Rust core (`src-tauri`). Every call degrades gracefully
 * when the UI runs in a plain browser (e.g. `pnpm dev` or Playwright).
 */
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

/** Mirrors `MenuAction` in `src-tauri/src/menu.rs` (kebab-case). */
export type MenuAction =
  | "new-song"
  | "open"
  | "clear-recent"
  | "save"
  | "save-as"
  | "export-musicxml"
  | "export-midi"
  | "export-ascii-tab"
  | "close-window"
  | "quit"
  | "undo"
  | "redo"
  | "toggle-edit-mode"
  | "toggle-theme"
  | "toggle-fretboard"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-fullscreen"
  | "add-track"
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
  "xml",
] as const;

/** Mirrors `WRITE_EXTENSIONS` in `src-tauri/src/score_write.rs`. */
export const SAVE_EXTENSIONS = ["gp", "gp5", "mid", "midi", "musicxml", "txt", "wav"] as const;

/** Mirrors `ErrorKind` in `src-tauri/src/error.rs`. */
export type CommandErrorKind =
  | "not-found"
  | "unsupported-type"
  | "too-large"
  | "not-a-score"
  | "invalid-key"
  | "invalid-settings"
  | "invalid-menu-state"
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
export const MIXER_SETTINGS_VERSION = 1;

/** Mirrors `MixerSettings` in `src-tauri/src/mixer.rs`. */
export interface MixerSettings {
  version: typeof MIXER_SETTINGS_VERSION;
  /** Master volume, 0 to 1. */
  master: number;
  tracks: TrackMix[];
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
      { name: "MusicXML files", extensions: ["musicxml", "xml"] },
      { name: "MIDI files", extensions: ["mid", "midi"] },
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
