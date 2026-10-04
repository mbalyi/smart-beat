import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import {
  MENU_EVENT,
  SCORE_EXTENSIONS,
  type AppInfo,
  type CommandError,
  type MenuAction,
  type MenuState,
  type MixerSettings,
  type Shortcut,
} from "@/lib/tauri";

/** Same shape the Rust `app_info` command returns (see src-tauri/tests/ipc.rs). */
export const APP_INFO: AppInfo = {
  name: "Smart Beat",
  version: "0.1.0",
  tauriVersion: "2.12.0",
  os: "macos",
  arch: "aarch64",
};

/** Same shape the Rust `menu_shortcuts` command returns on macOS. */
export const SHORTCUTS: Shortcut[] = [
  { action: "open", menu: "File", label: "Open…", keys: ["⌘", "O"], spoken: "Command+O" },
  {
    action: "quit",
    menu: "File",
    label: "Quit Smart Beat",
    keys: ["⌘", "Q"],
    spoken: "Command+Q",
  },
  {
    action: "toggle-theme",
    menu: "View",
    label: "Toggle Dark Mode",
    keys: ["⇧", "⌘", "L"],
    spoken: "Shift+Command+L",
  },
  {
    action: "shortcuts",
    menu: "Help",
    label: "Keyboard Shortcuts",
    keys: ["⌘", "/"],
    spoken: "Command+Slash",
  },
];

type CommandHandler = (args?: InvokeArgs) => unknown;

export interface IpcCall {
  cmd: string;
  args?: InvokeArgs;
}

/**
 * State behind the mocked Rust commands: files on "disk", saved mixes, and
 * what the Open dialog returns. Reset by {@link mockTauri}.
 */
export const backend = {
  files: new Map<string, Uint8Array>(),
  mixes: new Map<string, MixerSettings>(),
  /** Path the Open dialog picks, or `null` for Cancel. */
  dialogResult: null as string | null,
  /** The last menu state the UI sent. */
  menuState: null as MenuState | null,
  /** Recently opened songs, most recent first (see `src-tauri/src/recent.rs`). */
  recent: [] as string[],
  /** Path the Save dialog picks, or `null` for Cancel. */
  saveResult: null as string | null,
  /** Files written by `write_score_file`, by path. */
  written: new Map<string, Uint8Array>(),
  /** Settings stored inside saved `.gp` files, by path. */
  projectSettings: new Map<string, MixerSettings>(),
};

const MAX_RECENT = 10;

let lastOptions: { headers?: Record<string, string> } | undefined;

const fail = (kind: CommandError["kind"], message: string): never => {
  throw { kind, message } satisfies CommandError;
};

/** Mirrors `read_score_file` in src-tauri/src/score_file.rs (minus the signature check). */
function readScoreFile(args?: InvokeArgs): ArrayBuffer {
  const { path } = args as { path: string };
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!(SCORE_EXTENSIONS as readonly string[]).includes(extension)) {
    fail("unsupported-type", `“${path}” is not a Guitar Pro file.`);
  }
  const bytes = backend.files.get(path) ?? fail("not-found", `“${path}” could not be found.`);
  return bytes.slice().buffer;
}

/**
 * Installs Tauri IPC mocks that behave like the Rust core. Individual commands
 * can be overridden (e.g. to simulate failures). Returns the recorded calls.
 */
export function mockTauri(overrides: Record<string, CommandHandler> = {}): IpcCall[] {
  const calls: IpcCall[] = [];
  backend.files.clear();
  backend.mixes.clear();
  backend.dialogResult = null;
  backend.menuState = null;
  backend.recent = [];
  backend.saveResult = null;
  backend.written.clear();
  backend.projectSettings.clear();
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = overrides[cmd];
      if (override) return override(args);
      switch (cmd) {
        case "app_info":
          return APP_INFO;
        case "menu_shortcuts":
          return SHORTCUTS;
        case "read_score_file":
          return readScoreFile(args);
        case "load_mixer_settings":
          return backend.mixes.get((args as { fileKey: string }).fileKey) ?? null;
        case "save_mixer_settings": {
          const { fileKey, settings } = args as { fileKey: string; settings: MixerSettings };
          backend.mixes.set(fileKey, settings);
          return null;
        }
        case "load_recent_files":
          return backend.recent;
        case "add_recent_file": {
          const { path } = args as { path: string };
          backend.recent = [path, ...backend.recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
          return backend.recent;
        }
        case "remove_recent_file": {
          const { path } = args as { path: string };
          backend.recent = backend.recent.filter((p) => p !== path);
          return backend.recent;
        }
        case "clear_recent_files":
          backend.recent = [];
          return backend.recent;
        case "write_score_file": {
          // Raw body (bytes) plus the URI-encoded destination in a header.
          const path = decodeURIComponent(lastOptions?.headers?.path ?? "");
          backend.written.set(path, new Uint8Array(args as ArrayBuffer | Uint8Array));
          return null;
        }
        case "plugin:dialog|save":
          return backend.saveResult;
        case "update_menu_state":
          backend.menuState = (args as { state: MenuState }).state;
          return null;
        case "plugin:dialog|open":
          return backend.dialogResult;
        case "plugin:window|set_theme":
        case "plugin:window|set_title":
          return null;
        // The sound library starts empty; the native engine is never started here.
        case "library_list":
          return [];
        // No drum kits imported (#40); tests override these to have some.
        case "kits_list":
          return [];
        case "kits_remove":
        case "audio_set_track_kit":
          return null;
        case "audio_set_chain":
          return [];
        case "audio_set_sounds":
          return (args as { sounds: unknown[] }).sounds.map(() => []);
        case "read_project_settings":
          return backend.projectSettings.get((args as { path: string }).path) ?? null;
        case "write_project_settings": {
          const { path, settings } = args as { path: string; settings: MixerSettings };
          backend.projectSettings.set(path, settings);
          return null;
        }
        case "audio_set_automation":
        case "audio_set_track_eq":
        case "audio_set_drum_mix":
        case "audio_set_backing":
        case "audio_clear_backing":
          return null;
        case "audio_load_backing":
          return {
            name: "take.mp3",
            durationMs: 2000,
            sampleRate: 44100,
            channels: 2,
            peaks: Array.from({ length: 200 }, (_, i) => (i % 10) / 10),
            peaksPerSecond: 100,
          };
        case "audio_transport":
        case "audio_set_mix":
        case "audio_stop":
          return null;
        default:
          throw new Error(`Unmocked Tauri command: ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
  // mockIPC hides the invoke options; a write's destination header is needed.
  const internals = window.__TAURI_INTERNALS__ as unknown as {
    invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  };
  const inner = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    lastOptions = options as typeof lastOptions;
    return inner(cmd, args, options);
  };
  return calls;
}

/** Simulates the Rust core forwarding a native menu click. */
export async function emitMenuAction(action: MenuAction) {
  await emit(MENU_EVENT, action);
}

/** Simulates File › Open Recent: the core sends the chosen path. */
export async function emitOpenRecent(path: string) {
  await emit("open-recent", path);
}

/** Simulates the OS dragging files onto the window (Tauri webview events). */
export async function emitFileDrag(
  event: { type: "enter"; paths: string[] } | { type: "leave" } | { type: "drop"; paths: string[] },
) {
  const position = { x: 10, y: 10 };
  if (event.type === "leave") await emit("tauri://drag-leave", null);
  else await emit(`tauri://drag-${event.type}`, { paths: event.paths, position });
}
