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
};

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
        case "update_menu_state":
          backend.menuState = (args as { state: MenuState }).state;
          return null;
        case "plugin:dialog|open":
          return backend.dialogResult;
        case "plugin:window|set_theme":
        case "plugin:window|set_title":
          return null;
        default:
          throw new Error(`Unmocked Tauri command: ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
  return calls;
}

/** Simulates the Rust core forwarding a native menu click. */
export async function emitMenuAction(action: MenuAction) {
  await emit(MENU_EVENT, action);
}

/** Simulates the OS dragging files onto the window (Tauri webview events). */
export async function emitFileDrag(
  event: { type: "enter"; paths: string[] } | { type: "leave" } | { type: "drop"; paths: string[] },
) {
  const position = { x: 10, y: 10 };
  if (event.type === "leave") await emit("tauri://drag-leave", null);
  else await emit(`tauri://drag-${event.type}`, { paths: event.paths, position });
}
