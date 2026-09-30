// Injected before the app loads (page.addInitScript). A minimal stand-in for
// the Tauri IPC bridge that answers like the Rust core (commands, the Open
// dialog, events such as file drops), so the real UI, including alphaTab, can
// be exercised in Chromium and WebKit. Keep in sync with src/test/tauri.ts.
(() => {
  const APP_INFO = {
    name: "Smart Beat",
    version: "0.1.0",
    tauriVersion: "2.12.0",
    os: "macos",
    arch: "aarch64",
  };
  const SHORTCUTS = [
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

  const SCORE_EXTENSIONS = ["gp3", "gp4", "gp5", "gpx", "gp", "mid", "midi", "musicxml", "xml"];
  const MAX_RECENT = 10;

  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;

  /** Saved mixes by song key (see `load_mixer_settings` in src-tauri/src/mixer.rs). */
  const mixes = new Map();
  window.__mixes = mixes;
  /** Every command the UI sent, for assertions. */
  window.__ipcCalls = [];
  /** Path the native Open dialog "picks" (`null` = Cancel). Set by tests. */
  window.__dialogResult = null;
  /** The last menu state the UI sent (see `update_menu_state` in src-tauri/src/menu_state.rs). */
  window.__menuState = null;
  /** Recently opened songs (see `src-tauri/src/recent.rs`). */
  window.__recent = [];
  /** Path the native Save dialog "picks" (`null` = Cancel). Set by tests. */
  window.__saveResult = null;
  /** Files written by `write_score_file`, by path: they can be opened again. */
  window.__written = new Map();

  /**
   * Mirrors `read_score_file` in src-tauri/src/score_file.rs. Files are served
   * from e2e/fixtures/ under /__e2e__/files/ (see e2e/fixtures.ts).
   */
  const readScoreFile = async (path) => {
    if (window.__written.has(path)) return window.__written.get(path).slice().buffer;
    const name = path.split(/[\\/]/).pop();
    const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (!SCORE_EXTENSIONS.includes(extension)) {
      throw { kind: "unsupported-type", message: `“${name}” is not a Guitar Pro file.` };
    }
    const response = await fetch(`/__e2e__/files/${encodeURIComponent(name)}`);
    if (!response.ok) throw { kind: "not-found", message: `“${name}” could not be found.` };
    return response.arrayBuffer();
  };

  const invoke = async (cmd, args, options) => {
    window.__ipcCalls.push({ cmd, args });
    switch (cmd) {
      case "app_info":
        return APP_INFO;
      case "menu_shortcuts":
        return SHORTCUTS;
      case "read_score_file":
        return readScoreFile(args.path);
      case "load_mixer_settings":
        return mixes.get(args.fileKey) ?? null;
      case "save_mixer_settings":
        mixes.set(args.fileKey, args.settings);
        return null;
      case "load_recent_files":
        return window.__recent;
      case "add_recent_file":
        window.__recent = [args.path, ...window.__recent.filter((p) => p !== args.path)].slice(
          0,
          MAX_RECENT,
        );
        return window.__recent;
      case "remove_recent_file":
        window.__recent = window.__recent.filter((p) => p !== args.path);
        return window.__recent;
      case "clear_recent_files":
        window.__recent = [];
        return window.__recent;
      case "write_score_file": {
        // The bytes are the raw body; the URI-encoded path travels in a header.
        const path = decodeURIComponent(options?.headers?.path ?? "");
        window.__written.set(path, new Uint8Array(args));
        return null;
      }
      case "plugin:dialog|save":
        return window.__saveResult;
      case "update_menu_state":
        window.__menuState = args.state;
        return null;
      case "plugin:dialog|open":
        return window.__dialogResult;
      case "plugin:window|set_title":
        document.title = args.value;
        return null;
      case "plugin:window|set_theme":
        return null;
      case "plugin:event|listen": {
        const handlers = listeners.get(args.event) ?? [];
        handlers.push(args.handler);
        listeners.set(args.event, handlers);
        return args.handler;
      }
      case "plugin:event|unlisten": {
        const handlers = listeners.get(args.event) ?? [];
        listeners.set(
          args.event,
          handlers.filter((id) => id !== args.eventId),
        );
        return null;
      }
      default:
        throw new Error(`Unmocked Tauri command: ${cmd}`);
    }
  };

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event, id) {
      callbacks.delete(id);
    },
  };

  /** Test hook: emit a Tauri event. Returns how many listeners received it. */
  window.__emitTauriEvent = (event, payload) => {
    const ids = listeners.get(event) ?? [];
    for (const id of ids) callbacks.get(id)?.({ event, id, payload });
    return ids.length;
  };

  /** Test hook: simulate the Rust core forwarding a native menu click. */
  window.__emitMenuAction = (action) => window.__emitTauriEvent("menu-action", action);
})();
