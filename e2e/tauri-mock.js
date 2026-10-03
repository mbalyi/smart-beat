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

  const SCORE_EXTENSIONS = [
    "gp3",
    "gp4",
    "gp5",
    "gpx",
    "gp",
    "mid",
    "midi",
    "musicxml",
    "xml",
    "mscx",
    "mscz",
    "atex",
    "capx",
    "txt",
  ];
  const MAX_RECENT = 10;

  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;

  /** Saved mixes by song key (see `load_mixer_settings` in src-tauri/src/mixer.rs). */
  const mixes = new Map();
  window.__mixes = mixes;
  /** Every command the UI sent, for assertions. */
  window.__ipcCalls = [];
  /** Settings stored inside saved `.gp` files, by path. */
  window.__projectSettings = {};
  window.__embeddedAudio = false;
  /** What the native engine was told besides chains and the mix. */
  window.__engineConfig = { sounds: {}, automation: {}, eq: {}, drums: {} };
  window.__engineBacking = null;
  /** Levels the engine reports while playing. */
  window.__meters = {
    tracks: [0.5, 0.5, 0.5, 0.5],
    master: 0.7,
    drums: [],
    backing: 0.4,
    // Gain reduction (dB) per pedalboard slot (#39).
    reduction: { tracks: [[4.5], [], [3, 3, 3, 3, 3, 3], []], master: [0, 2.5, 1.5] },
  };
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

  // The sound library: generated cabinets plus what the tests import.
  const builtinCab = (id, name) => ({
    id: `builtin:${id}`,
    kind: "cab",
    name,
    tags: [],
    file: "",
    sampleRate: 0,
    source: "Smart Beat",
    builtin: true,
    includesCab: false,
  });
  window.__library = [
    builtinCab("4x12-modern", "4×12 modern (generated)"),
    builtinCab("4x12-vintage", "4×12 vintage (generated)"),
    builtinCab("2x12-open", "2×12 open back (generated)"),
    builtinCab("8x10-bass", "8×10 bass (generated)"),
  ];
  // The native engine: a clock that runs while "playing" (no sound in tests).
  const engine = { playing: false, startedAt: 0, position: 0, durationMs: 0, chains: {} };
  const enginePosition = () =>
    engine.playing ? engine.position + (performance.now() - engine.startedAt) : engine.position;

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
      case "library_list":
        return window.__library;
      case "library_import": {
        const name = args.path
          .split("/")
          .pop()
          .replace(/\.[^.]+$/, "");
        const item = {
          id: `lib-${window.__library.length}`,
          kind: args.kind,
          name,
          tags: [],
          file: args.path,
          sampleRate: 48000,
          source: args.path.split("/").pop(),
          builtin: false,
          includesCab: false,
        };
        window.__library = [...window.__library, item];
        return item;
      }
      case "library_update": {
        window.__library = window.__library.map((i) =>
          i.id === args.id ? { ...i, name: args.name, tags: args.tags } : i,
        );
        return window.__library.find((i) => i.id === args.id);
      }
      case "library_remove":
        window.__library = window.__library.filter((i) => i.id !== args.id);
        return null;
      case "audio_load_soundfont":
      case "audio_stop":
      case "audio_set_mix":
        return null;
      case "read_project_settings":
        return window.__projectSettings[args.path] ?? null;
      case "write_project_settings":
        window.__projectSettings[args.path] = args.settings;
        window.__embeddedAudio = args.embedAudio;
        return null;
      case "audio_set_sounds":
        engine.chains[args.track] = args.sounds[0];
        window.__engineChains = engine.chains;
        window.__engineConfig.sounds[args.track] = { sounds: args.sounds, switches: args.switches };
        return args.sounds.map(() => []);
      case "audio_set_automation":
        window.__engineConfig.automation[args.track] = args.automation;
        return null;
      case "audio_set_track_eq":
        window.__engineConfig.eq[args.track] = args.eq;
        return null;
      case "audio_set_drum_mix":
        window.__engineConfig.drums[args.track] = args.drums;
        return null;
      case "audio_load_backing": {
        const source = args.source;
        const path = source.type === "file" ? source.path : source.name;
        if (path.includes("missing")) {
          throw { kind: "not-found", message: `“${path}” does not exist.` };
        }
        // A 4 s recording whose level swells and fades once per second.
        const peaks = Array.from(
          { length: 400 },
          (_, i) => 0.2 + 0.7 * Math.abs(Math.sin((i * Math.PI) / 100)),
        );
        window.__engineBacking = { source, params: null, sync: [] };
        return {
          name: path.split(/[\\/]/).pop(),
          durationMs: 4000,
          sampleRate: 44100,
          channels: 2,
          peaks,
          peaksPerSecond: 100,
        };
      }
      case "audio_set_backing":
        if (!window.__engineBacking) throw { kind: "audio", message: "No audio track is loaded" };
        window.__engineBacking = {
          ...window.__engineBacking,
          params: args.params,
          sync: args.sync,
        };
        return null;
      case "audio_clear_backing":
        window.__engineBacking = null;
        return null;
      case "audio_start":
      case "audio_state":
        return {
          running: true,
          sampleRate: 48000,
          positionMs: enginePosition(),
          durationMs: engine.durationMs,
          playing: engine.playing,
          latencyMs: 10,
          dropouts: 0,
          loadPercent: 1,
          meters: engine.playing ? window.__meters : { tracks: [], master: 0 },
        };
      case "audio_load_song":
        // 120 BPM is close enough for the clock in tests.
        engine.durationMs = (args.song.endTick / args.song.division) * 500;
        engine.chains = {};
        return null;
      case "audio_set_chain":
        engine.chains[args.sound ? `${args.track}:${args.sound}` : (args.track ?? "master")] =
          args.slots;
        window.__engineChains = engine.chains;
        return [];
      case "audio_transport": {
        const c = args.command;
        if (c.type === "play" && !engine.playing) {
          engine.playing = true;
          engine.startedAt = performance.now();
        } else if (c.type === "pause" && engine.playing) {
          engine.position = enginePosition();
          engine.playing = false;
        } else if (c.type === "seek") {
          engine.position = c.ms;
          engine.startedAt = performance.now();
        }
        return null;
      }
      case "audio_render":
        return new Float32Array(2 * 4410).buffer;
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
