import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import { MENU_EVENT, type AppInfo, type MenuAction, type Shortcut } from "@/lib/tauri";

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
 * Installs Tauri IPC mocks that behave like the Rust core. Individual commands
 * can be overridden (e.g. to simulate failures). Returns the recorded calls.
 */
export function mockTauri(overrides: Record<string, CommandHandler> = {}): IpcCall[] {
  const calls: IpcCall[] = [];
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
        case "plugin:window|set_theme":
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
