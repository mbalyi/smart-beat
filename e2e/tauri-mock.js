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
    "mxl",
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
  window.__transcription = { configured: true, midiBase64: "", cancelled: [], requests: [] };
  /**
   * Record to Tab (src-tauri/src/recording.rs). Every request is kept. `shift` moves the notes
   * later (seconds): a click-mode take starts with the count-in. `hold` keeps the call open until
   * `release()` or a cancel; `fail` makes it reject with that message.
   */
  window.__recordTranscription = {
    requests: [],
    cancelled: 0,
    hold: false,
    fail: null,
    shift: 0,
    release: null,
    abort: null,
  };
  /** Settings stored inside saved `.gp` files, by path. */
  window.__projectSettings = {};
  window.__embeddedAudio = false;
  /** What the native engine was told besides chains and the mix. */
  window.__engineConfig = { sounds: {}, automation: {}, eq: {}, drums: {}, kits: {} };
  /** Imported drum kits (#40). */
  window.__kits = [];
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
  window.__usage = { enabled: true, available: false, noticeSeen: true };
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
    note: "",
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
      // `export_m4a` encodes the WAV it is sent as AAC; the mock keeps the WAV.
      case "export_m4a":
      case "write_score_file": {
        // The bytes are the raw body; the URI-encoded path travels in a header.
        const path = decodeURIComponent(options?.headers?.path ?? "");
        window.__written.set(path, new Uint8Array(args));
        return null;
      }
      // Export as PDF prints the window's print copy to a file (#83): record what was there.
      case "export_pdf": {
        window.__pdfExports = window.__pdfExports ?? [];
        window.__pdfExports.push({
          path: args.path,
          page: args.page,
          parts: document.querySelectorAll("#print-root svg").length,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (window.__pdfFail) throw { kind: "io", message: window.__pdfFail };
        return null;
      }
      // Usage counters (#99): tests read `window.__ipcCalls` for `track_event` and set
      // `window.__usage` ({ enabled, available, noticeSeen }) to simulate a release build.
      case "track_event":
        return null;
      case "get_usage_settings":
        return window.__usage;
      case "set_usage_settings":
        window.__usage = {
          ...window.__usage,
          enabled: args.enabled ?? window.__usage.enabled,
          noticeSeen: args.noticeSeen ?? window.__usage.noticeSeen,
        };
        return window.__usage;
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
      // The updater plugin: tests set `window.__update` ({ version, body }) to have a new version
      // found, `__updateError` ({ during: "check" | "install", message }) to make it fail, and
      // `__updateHold = true` to keep a download open until `__releaseUpdate()` is called.
      case "plugin:updater|check":
        if (window.__updateError?.during === "check") throw window.__updateError.message;
        if (!window.__update) return null;
        return {
          rid: 7,
          currentVersion: APP_INFO.version,
          version: window.__update.version,
          date: "2026-11-01T00:00:00Z",
          body: window.__update.body,
          rawJson: {},
        };
      case "plugin:updater|download_and_install": {
        const send = (message) => args.onEvent.onmessage(message);
        send({ event: "Started", data: { contentLength: 3000 } });
        send({ event: "Progress", data: { chunkLength: 1000 } });
        if (window.__updateHold) await new Promise((resolve) => (window.__releaseUpdate = resolve));
        if (window.__updateError?.during === "install") throw window.__updateError.message;
        send({ event: "Progress", data: { chunkLength: 2000 } });
        send({ event: "Finished" });
        return null;
      }
      case "plugin:opener|open_url":
      case "plugin:process|restart":
      case "plugin:resources|close":
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
        // Like the Rust side: a "broken" file is refused with a reason, a capture
        // given to the cabinet importer (or the other way round) too, and a
        // "hall" impulse response is imported with a note about its length.
        const file = args.path.split("/").pop();
        const name = file.replace(/\.[^.]+$/, "");
        const isNam = /\.nam$/i.test(file);
        if (/broken/i.test(file)) {
          throw {
            kind: "audio",
            message: isNam
              ? "This is not a Neural Amp Modeler file the app can use (unknown architecture)"
              : "This is not a WAV file the app can read (unexpected end of file)",
          };
        }
        if ((args.kind === "amp") !== isNam) {
          throw {
            kind: "audio",
            message:
              args.kind === "amp"
                ? "This is not a Neural Amp Modeler (.nam) file"
                : "This is not a WAV file the app can read (not a RIFF file)",
          };
        }
        const item = {
          id: `lib-${window.__library.length}`,
          kind: args.kind,
          name,
          tags: [],
          file: args.path,
          sampleRate: 48000,
          source: file,
          builtin: false,
          includesCab: false,
          note: /hall/i.test(file)
            ? "Only the first 1.4 s of this 3.0 s impulse response is used."
            : "",
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
      case "kits_list":
        return window.__kits;
      case "kits_import": {
        // Like the Rust side: a path with "nc" in its folder has a non-commercial
        // licence, "cc-by" one with a CC BY licence, anything else none.
        const options = args.options ?? {};
        // Named after the file, or its folder for a generic "kit.sfz" (as in Rust).
        const parts = args.path.split("/");
        const stem = parts.at(-1).replace(/\.[^.]+$/, "");
        const name =
          options.name ||
          (["kit", "drumkit", "drums", "main", "default"].includes(stem.toLowerCase())
            ? parts.at(-2)
            : stem);
        if (args.path.includes("/nc/")) {
          throw {
            kind: "audio",
            message:
              "This kit cannot be imported. Its licence does not allow commercial use (non-commercial).",
          };
        }
        const found = args.path.includes("/cc-by/");
        if (!found && !options.licence && !options.acceptUnknown) {
          throw {
            kind: "audio",
            message: "The kit's licence could not be found: confirm that you may use it.",
          };
        }
        const kit = {
          id: `kit-${window.__kits.length + 1}`,
          name,
          format: args.path.endsWith(".sfz") ? "sfz" : "sf2",
          licence: {
            kind: options.licence ?? (found ? "cc-by" : "unknown"),
            ...((options.attribution || found) && {
              attribution: options.attribution ?? "Recorded by Test Drummer",
            }),
          },
          pieces: [
            { element: "snare", keys: [38] },
            { element: "hihat", keys: [42, 46] },
            { element: "kick", keys: [36] },
          ],
          missing: ["tom1", "ride"],
          sizeBytes: 3 * 1024 * 1024,
          warnings: [],
        };
        window.__kits = [...window.__kits, kit];
        return kit;
      }
      case "kits_remove":
        window.__kits = window.__kits.filter((k) => k.id !== args.id);
        return null;
      case "audio_set_track_kit":
        window.__engineConfig.kits[args.track] = args.kit;
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
      // Import from Audio (src-tauri/src/transcription.rs). Tests set `midiBase64` to the result.
      case "transcription_configured":
        return window.__transcription.configured;
      case "cancel_transcription":
        window.__transcription.cancelled.push(args.operationId);
        return null;
      case "transcribe_audio":
        // Like Tauri's IPC: the recording is the raw body, its details are headers.
        if (!["mp3", "wav", "flac", "ogg"].includes(options.headers["file-type"])) {
          throw { kind: "audio", message: "Choose MP3, WAV, FLAC or OGG audio." };
        }
        window.__transcription.requests.push(options.headers);
        return {
          midiBase64: window.__transcription.midiBase64,
          notes: [60, 64, 67].map((pitch, i) => ({
            pitch,
            start: i * 0.5,
            end: i * 0.5 + 0.5,
            instrument: "clean_electric_guitar",
            velocity: null,
          })),
          durationSeconds: 1.5,
        };
      case "transcribe_recording": {
        // Like Tauri's IPC: the samples are the raw body, the rate is a header.
        const state = window.__recordTranscription;
        state.requests.push({
          sampleRate: Number(options.headers["x-sample-rate"]),
          bytes: args.byteLength,
        });
        window.__emitTauriEvent("recording-transcription-progress", { fraction: 0.5 });
        if (state.hold) {
          await new Promise((resolve, reject) => {
            state.release = resolve;
            state.abort = () => reject("Transcription stopped.");
          });
        }
        if (state.fail) throw { kind: "audio", message: state.fail };
        // Three open strings, then an E major chord: E2, A2, D3 and E2 B2 E3 G#3.
        const notes = [
          [40, 0.0, 0.5],
          [45, 0.5, 1.0],
          [50, 1.0, 1.5],
          [40, 1.5, 2.0],
          [47, 1.5, 2.0],
          [52, 1.5, 2.0],
          [56, 1.5, 2.0],
        ].map(([pitch, start, end]) => ({
          pitch,
          start: start + state.shift,
          end: end + state.shift,
          velocity: 0.8,
        }));
        return { notes };
      }
      case "cancel_recording_transcription":
        window.__recordTranscription.cancelled += 1;
        window.__recordTranscription.abort?.();
        return null;
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
