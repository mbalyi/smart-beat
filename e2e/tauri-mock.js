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
    { action: "open", menu: "File", label: "Open", keys: ["⌘", "O"], spoken: "Command+O" },
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
  /** The high-accuracy piano model (src-tauri/src/recording/piano_model.rs): not downloaded at first. */
  window.__pianoModel = { installed: false, downloads: 0, removed: 0, fail: null };
  /**
   * MuScriptor, the optional AI model (#150, src-tauri/src/recording/muscriptor_model.rs): nothing
   * downloaded and no terms accepted at first. `hold` keeps a download running until `release()`
   * or a cancel; `fail` makes it reject.
   */
  window.__muscriptor = {
    // The terms are accepted per model size.
    terms: { small: false, medium: false, large: false },
    rightsConfirmed: [],
    installed: { small: false, medium: false, large: false },
    downloads: [],
    cancelled: 0,
    deleted: [],
    hold: false,
    fail: null,
    release: null,
    abort: null,
  };
  const MUSCRIPTOR_BYTES = { small: 209425152, medium: 618442496, large: 2739142176 };
  const muscriptorStatus = () => ({
    supported: true,
    termsVersion: 1,
    sizes: ["small", "medium", "large"].map((size) => ({
      size,
      bytes: MUSCRIPTOR_BYTES[size],
      installed: window.__muscriptor.installed[size],
      termsAccepted: window.__muscriptor.terms[size],
      partialBytes: 0,
    })),
  });
  /**
   * Stem separation (#186, src-tauri/src/stems/). `songs` is the library, newest first. `hold`
   * keeps a separation running until `release()` or a cancel; `fail` makes it reject; `mono`
   * makes the song a mono file (vocals and panned cannot be separated); `holdRender` keeps a
   * slowed mix from being rendered until `releaseRender()`; `originalMissing` makes the next
   * separated songs ones whose original file is gone (`hasOriginal: false`); `clock` stamps
   * `createdAtMs` and `lastOpened` so the order of the library is stable. `tempo` is what
   * `stems_detect_tempo` returns (a test can replace it), `tempoRequests` the ids it was asked for.
   */
  window.__stems = {
    tempo: {
      bpm: 120,
      confidence: 0.9,
      firstBeatSec: 0.5,
      alternatives: [60, 240],
      steady: true,
      sections: [],
    },
    tempoRequests: [],
    songs: [],
    originalMissing: false,
    clock: 1790000000000,
    requests: [],
    reads: [],
    renders: [],
    cancelled: 0,
    hold: false,
    holdRender: false,
    fail: null,
    mono: false,
    release: null,
    abort: null,
    releaseRender: null,
  };
  /**
   * Saved stem files, `.sbstems` (#186, src-tauri/src/stems/bundle.rs). `saves` are the
   * `stems_save_bundle` requests, `files` the bundles on the fake disk by path (a save adds one;
   * a test can add a `StemSong` under a path to have it opened with `stems_open_bundle`), `opens`
   * the paths that were opened. `hold` keeps a save or an open running until `release()` or
   * `abort()`; `fail` makes the next one reject.
   */
  window.__stemBundles = {
    saves: [],
    opens: [],
    files: {},
    hold: false,
    fail: null,
    release: null,
    abort: null,
  };
  /**
   * The linked cloud folder (#187) and the stems in it (#186). `folder` is the linked folder (`null`
   * = none, so `get_cloud_folder` answers `null`); `scores` is what `list_cloud_scores` returns.
   * `list_cloud_stems` lists the saved stem files (`window.__stemBundles.files`) whose path is in
   * the folder, so a save into it appears there, with the size and time of that save in `meta`
   * (`size` and `modified_ms`, as the Rust `CloudScore` serializes them). A path in `placeholders`
   * is a cloud-only file: opening it announces "cloud-download-waiting" and waits until
   * `download(path)` (the drive app finished) is called. `savePaths` lists the answers of
   * `stems_cloud_save_path`, `estimates` the `stems_estimate_bundle` requests, `estimateBytes`
   * overrides the estimate (`null` = the library size plus 3 MiB for the original).
   */
  window.__cloud = {
    folder: null,
    scores: [],
    meta: {},
    placeholders: {},
    savePaths: [],
    estimates: [],
    estimateBytes: null,
    waiting: {},
    download(path) {
      delete window.__cloud.placeholders[path];
      window.__cloud.waiting[path]?.();
    },
  };
  /**
   * Stems in connected cloud accounts (#186). `accounts` is what `cloud_accounts` answers (none
   * connected = none; an entry is `{ provider, label, account }`), `stems` the `.sbstems` files
   * `cloud_list_stems` lists by provider (a save adds one; the song itself is kept in
   * `window.__stemBundles.files` under its item id, so it can be opened again), `listError` makes
   * a provider's listing reject, `saves` and `opens` are the requests, `hold` keeps a save or an
   * open running until `release()` or a `stems_cancel` (which rejects as the Rust commands do),
   * `fail` makes the next one reject with that error object.
   */
  window.__drives = {
    accounts: [],
    stems: {},
    /** The tabs `cloud_list` lists by provider (a `cloud_create` adds one). */
    tabs: {},
    listError: {},
    /** The `cloud_share` requests, `{ item, level }`; `shareError` makes the next one reject. */
    shares: [],
    shareError: null,
    /** The `cloud_create` requests, `{ provider, name, bytes }`. */
    creates: [],
    saves: [],
    opens: [],
    hold: false,
    fail: null,
    release: null,
    abort: null,
    counter: 0,
  };
  /** Waits while `window.__drives.hold` is set; a `stems_cancel` rejects it as the real ones do. */
  const heldDriveTransfer = async () => {
    const drives = window.__drives;
    if (!drives.hold) return;
    await new Promise((resolve, reject) => {
      drives.release = resolve;
      drives.abort = () => reject({ kind: "io", message: "Stem file stopped." });
    });
  };
  /** The `.sbstems` files in the linked folder, as `CloudStem` (`list_cloud_stems`). */
  const cloudStems = () => {
    const cloud = window.__cloud;
    if (!cloud.folder) return [];
    const prefix = `${cloud.folder}/`;
    return Object.keys(window.__stemBundles.files)
      .filter((path) => path.startsWith(prefix) && path.endsWith(".sbstems"))
      .map((path) => ({
        name: path.slice(prefix.length).replace(/\.sbstems$/, ""),
        path,
        size: cloud.meta[path]?.size ?? 40 * 1024 * 1024,
        modified_ms: cloud.meta[path]?.modified_ms ?? 1790000000000,
        placeholder: Boolean(cloud.placeholders[path]),
      }));
  };

  /**
   * The downloadable stem models (#186, src-tauri/src/stems/umx_model.rs and models.rs), by
   * engine: `neural` is UMX-HQ (its own `umx_model_*` commands), the rest use `stem_model_*`.
   * `available: false` is a model that is not published yet. `hold` keeps a download running
   * until `release()` or a cancel; `fail` makes it reject; `downloads` lists the started ones.
   */
  const STEM_MODEL_BYTES = {
    neural: 142551184,
    scnet: 52271228,
    "scnet-xl": 216163649,
    htdemucs: 176589623,
    // Hosted since 2026-11-04 (src-tauri/src/stems/models.rs). Set available to false to see it withdrawn.
    "htdemucs-6s": 116246052,
  };
  window.__stemModels = {
    models: Object.fromEntries(
      Object.entries(STEM_MODEL_BYTES).map(([engine, bytes]) => [
        engine,
        {
          downloaded: false,
          termsAccepted: false,
          termsVersion: 1,
          downloadBytes: bytes,
          licence: `The terms of ${engine}: its weights have no stated licence.`,
          licenceSummary: "Weights without a stated licence.",
          available: true,
        },
      ]),
    ),
    downloads: [],
    removed: [],
    cancelled: 0,
    hold: false,
    fail: null,
    release: null,
    abort: null,
  };
  /** The status of a model as its command returns it (UMX-HQ has no `model` and no `available`). */
  const stemModelStatus = (engine) => {
    const { available, ...status } = window.__stemModels.models[engine];
    return engine === "neural" ? status : { model: engine, available, ...status };
  };
  const stemModelDownload = async (engine) => {
    const models = window.__stemModels;
    models.downloads.push(engine);
    const progress = (fraction) =>
      window.__emitTauriEvent(
        engine === "neural" ? "umx-model-download-progress" : "stem-model-download-progress",
        {
          ...(engine === "neural" ? {} : { model: engine }),
          downloadedBytes: Math.round(STEM_MODEL_BYTES[engine] * fraction),
          totalBytes: STEM_MODEL_BYTES[engine],
        },
      );
    progress(0.5);
    if (models.hold) {
      await new Promise((resolve, reject) => {
        models.release = resolve;
        models.abort = () => reject({ kind: "audio", message: "Download stopped." });
      });
    }
    if (models.fail) throw { kind: "network", message: models.fail };
    progress(1);
    models.models[engine].downloaded = true;
    return null;
  };
  /** A 16-bit stereo WAV of a quiet sine, as `stems_read` returns it. */
  const stemWav = (seconds, frequency) => {
    const rate = 8000;
    const frames = Math.round(rate * seconds);
    const bytes = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(bytes);
    const text = (offset, value) =>
      [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + frames * 4, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, frames * 4, true);
    for (let i = 0; i < frames; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 8000);
      view.setInt16(44 + i * 4, sample, true);
      view.setInt16(46 + i * 4, sample, true);
    }
    return bytes;
  };
  const STEM_SECONDS = 6;
  const STEM_FREQUENCY = {
    drums: 220,
    bass: 110,
    vocals: 440,
    guitar: 262,
    piano: 523,
    panned: 330,
    other: 165,
  };
  /** Settings stored inside saved `.gp` files, by path. */
  window.__projectSettings = {};
  /** What the native engine was told besides chains and the mix. */
  window.__engineConfig = { sounds: {}, automation: {}, eq: {}, drums: {}, kits: {} };
  /** Imported drum kits (#40). */
  window.__kits = [];
  /**
   * SoundFonts the user added (#81, src-tauri/src/audio/soundfonts.rs). `hold` keeps a download
   * running until the test cancels it or sets `fail`.
   */
  window.__soundfonts = { items: [], activated: [], downloads: [], cancelled: 0, hold: false };
  const SOUNDFONT_CATALOGUE = [
    {
      id: "musescore-general",
      name: "MuseScore General",
      description: "A large General MIDI bank made for MuseScore and built on FluidR3.",
      licence: "MIT",
      personalUseOnly: false,
      page: "https://musescore.org/en/handbook/3/soundfonts-and-sfz-files",
      downloadBytes: 39900972,
      bytes: 39900972,
    },
    {
      id: "generaluser-gs",
      name: "GeneralUser GS",
      description: "A small General MIDI and GS bank with 259 presets and 11 drum kits.",
      licence: "GeneralUser GS License v2.0 (free, including commercial use)",
      personalUseOnly: false,
      page: "https://github.com/mrbumpy409/GeneralUser-GS",
      downloadBytes: 32319396,
      bytes: 32319396,
    },
    {
      id: "fluidr3-gm",
      name: "FluidR3 GM (stereo)",
      description: "The classic full stereo FluidR3 General MIDI bank.",
      licence: "MIT",
      personalUseOnly: false,
      page: "https://github.com/pianobooster/fluid-soundfont",
      downloadBytes: 148398306,
      bytes: 148398306,
    },
    {
      id: "timbres-of-heaven",
      name: "Timbres of Heaven",
      description: "A very detailed General MIDI, GS and XG bank. Very large.",
      licence: "Free for personal use only. Do not redistribute.",
      personalUseOnly: true,
      page: "https://midkar.com/SoundFonts/TOH.html",
      downloadBytes: 264239592,
      bytes: 395249188,
    },
    {
      id: "arachno",
      name: "Arachno",
      description: "A full-size General MIDI bank with 9 drum kits.",
      licence: "Free for personal use only. Do not redistribute.",
      personalUseOnly: true,
      page: "http://www.arachnosoft.com/main/download.php?id=soundfont-sf2",
      downloadBytes: 143356181,
      bytes: 155405818,
    },
  ];
  /** The lanes as the engine was last told, and the audio files it loaded (by id). */
  window.__engineLanes = null;
  window.__engineSources = {};
  /** Levels the engine reports while playing. */
  window.__meters = {
    tracks: [0.5, 0.5, 0.5, 0.5],
    master: 0.7,
    drums: [],
    lanes: [],
    // Gain reduction (dB) per pedalboard slot (#39).
    reduction: { tracks: [[4.5], [], [3, 3, 3, 3, 3, 3], []], master: [0, 2.5, 1.5] },
  };
  /** Path the native Open dialog "picks" (`null` = Cancel). Set by tests. */
  window.__dialogResult = null;
  /** The last menu state the UI sent (see `update_menu_state` in src-tauri/src/menu_state.rs). */
  window.__menuState = null;
  /** Recently opened songs (see `src-tauri/src/recent.rs`). */
  window.__recent = [];
  /** Songs the system asked to open that the page has not collected (`src-tauri/src/open_file.rs`). */
  window.__pendingOpen = [];
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
      case "take_pending_open_files":
        return window.__pendingOpen.splice(0);
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
      // Practice together (#158): the link to the other app is simulated. Tests drive the guest
      // through `window.__practiceTogether` (see below) and read what the app sent.
      case "practice_host":
        return {
          code: "ABCD-EFGH-JKMN-PQRS-TVWX",
          link: "smartbeat://join/ABCD-EFGH-JKMN-PQRS-TVWX",
          address: "192.168.1.5:50123",
        };
      case "practice_join":
        return null;
      case "practice_send": {
        window.__practiceTogether.receive(args.text, args.conn ?? 1);
        return true;
      }
      case "practice_kick":
        window.__practiceTogether.kicked.push({ conn: args.conn, ban: args.ban });
        window.__practiceTogether.state("closed", "the guest disconnected", args.conn);
        return null;
      case "practice_leave":
        return null;
      case "practice_signal_available":
        return false;
      case "practice_signal_create":
        return "ABCD-EFGH";
      case "practice_signal_join":
      case "practice_signal_send":
      case "practice_signal_kick":
      case "practice_signal_leave":
        return null;
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
      case "soundfonts_list":
        return window.__soundfonts.items;
      case "soundfonts_catalogue":
        return SOUNDFONT_CATALOGUE.map((item) => ({
          ...item,
          installed: window.__soundfonts.items.some((i) => i.id === item.id),
        }));
      case "soundfonts_import": {
        // Like the Rust side: only .sf2 and .sf3 files, named after the file.
        if (!/\.(sf2|sf3)$/i.test(args.path)) {
          throw { kind: "audio", message: "Choose a SoundFont file (.sf2 or .sf3)." };
        }
        const file = args.path.split("/").at(-1);
        const name = file.replace(/\.[^.]+$/, "");
        const base = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        let id = base;
        for (let n = 2; window.__soundfonts.items.some((i) => i.id === id); n += 1) {
          id = `${base}-${n}`;
        }
        const item = { id, name, file, bytes: 5000000, catalogue: null };
        window.__soundfonts.items = [...window.__soundfonts.items, item];
        return item;
      }
      case "soundfonts_download": {
        const entry = SOUNDFONT_CATALOGUE.find((i) => i.id === args.id);
        window.__soundfonts.downloads.push(args.id);
        window.__emitTauriEvent("soundfont-download-progress", {
          id: args.id,
          fraction: 0.5,
          unpacking: false,
        });
        if (window.__soundfonts.hold) {
          await new Promise((resolve, reject) => {
            window.__soundfonts.release = { resolve, reject };
          });
        }
        if (window.__soundfonts.fail) throw { kind: "audio", message: window.__soundfonts.fail };
        window.__emitTauriEvent("soundfont-download-progress", {
          id: args.id,
          fraction: 1,
          unpacking: true,
        });
        const item = {
          id: entry.id,
          name: entry.name,
          file: `${entry.id}.sf2`,
          bytes: entry.bytes,
          catalogue: entry.id,
        };
        window.__soundfonts.items = [...window.__soundfonts.items, item];
        return item;
      }
      case "soundfonts_cancel_download":
        window.__soundfonts.cancelled += 1;
        window.__soundfonts.release?.reject({ kind: "audio", message: "cancelled" });
        return null;
      case "soundfonts_remove":
        window.__soundfonts.items = window.__soundfonts.items.filter((i) => i.id !== args.id);
        return null;
      case "soundfonts_activate":
        window.__soundfonts.activated.push(args.id);
        return `sf:${args.id}`;
      case "soundfonts_read":
        // A real SoundFont, so alphaTab's synthesizer can load it.
        return (await fetch("/soundfont/sonivox.sf3")).arrayBuffer();
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
      case "audio_load_source": {
        const location = args.location;
        const path = location.type === "file" ? location.path : location.entry;
        if (path.includes("missing")) {
          throw { kind: "not-found", message: `“${path}” does not exist.` };
        }
        const name = path.split(/[\\/]/).pop();
        // A stable fake content id per name (the real one is the SHA-256 of the file).
        let hash = 7;
        for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        const id = hash.toString(16).padStart(8, "0").repeat(8);
        window.__engineSources[id] = location;
        // A 4 s recording whose level swells and fades once per second.
        const peaks = Array.from(
          { length: 400 },
          (_, i) => 0.2 + 0.7 * Math.abs(Math.sin((i * Math.PI) / 100)),
        );
        return {
          id,
          name,
          ext: name.split(".").pop().toLowerCase(),
          durationMs: 4000,
          sampleRate: 44100,
          channels: 2,
          peaks,
          peaksPerSecond: 100,
        };
      }
      case "audio_add_take": {
        // A recorded take arrives as WAV bytes with its name in a header.
        const name = options?.headers?.["x-name"] ?? "Take.wav";
        const id = "e".repeat(64);
        window.__engineSources[id] = { type: "take", bytes: new Uint8Array(args).length };
        return {
          id,
          name,
          ext: "wav",
          durationMs: 4000,
          sampleRate: 48000,
          channels: 1,
          peaks: [0.5, 0.6],
          peaksPerSecond: 1,
        };
      }
      case "audio_set_lanes":
        window.__engineLanes = args.lanes;
        // Each lane sounds while the song plays.
        window.__meters.lanes = (args.lanes?.audio.lanes ?? [])
          .filter((l) => !l.folder)
          .map((l) => [l.id, 0.4]);
        return null;
      case "audio_forget_sources":
        return null;
      case "audio_zero_crossing":
        return args.ms;
      case "audio_extract_source":
        window.__extracted = { source: args.source, path: args.path, asWav: args.asWav };
        return null;
      case "audio_spectrogram":
        return Array.from({ length: args.columns }, (_, c) =>
          Array.from({ length: args.bins }, (_, b) => -90 + ((c + b) % 60)),
        );
      case "audio_loudness":
        return { integrated: -14.2, shortTermMax: -11.8, peakDb: -1.3 };
      case "audio_detect_beats":
        return { bpm: 120, beats: Array.from({ length: 64 }, (_, i) => i * 500) };
      case "audio_silent_regions":
        return [{ startMs: 1000, endMs: 2000 }];
      case "audio_start":
      case "audio_state":
        return {
          running: true,
          monitor: window.__engineMonitor
            ? {
                open: window.__engineMonitor.params.enabled,
                device: window.__engineMonitor.device ?? "System default",
                channels: 2,
                sampleRate: 48000,
                latencyMs: 5,
                error: null,
              }
            : null,
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
      case "audio_input_channels":
        return 2;
      case "audio_set_monitor":
        window.__engineMonitor = args.monitor;
        return args.monitor
          ? {
              open: args.monitor.params.enabled,
              device: args.monitor.device ?? "System default",
              channels: 2,
              sampleRate: 48000,
              latencyMs: 5,
              error: null,
            }
          : null;
      case "audio_set_monitor_chain":
        engine.chains.monitor = args.slots;
        window.__engineChains = engine.chains;
        return [];
      case "audio_set_chain":
        engine.chains[args.sound ? `${args.track}:${args.sound}` : (args.track ?? "master")] =
          args.slots;
        window.__engineChains = engine.chains;
        return [];
      // Third-party plugins (#80): the UI and what it sends.
      case "plugins_scan":
        return {
          plugins: [
            {
              format: "vst3",
              path: "/Library/Audio/Plug-Ins/VST3/TestAmp.vst3",
              name: "Test Amp",
              vendor: "Test",
              version: "1.0",
              hasGui: true,
            },
            {
              format: "clap",
              path: "/Library/Audio/Plug-Ins/CLAP/TestCab.clap",
              name: "Test Cab",
              vendor: "Test",
              version: "1.0",
              hasGui: false,
            },
          ],
          skipped: [],
        };
      case "plugins_set_enabled":
        window.__pluginsEnabled = args.enabled;
        return null;
      case "plugins_enabled":
        return window.__pluginsEnabled ?? false;
      case "audio_plugin_info":
        return window.__pluginLoading === undefined
          ? []
          : [
              {
                index: 0,
                name: "Test Amp",
                alive: !window.__pluginLoading,
                loading: window.__pluginLoading,
                latencySamples: 256,
                latencyMs: 5.3,
                error: "",
              },
            ];
      case "plugin_open_editor":
        return [800, 600];
      case "plugin_close_editor":
        return null;
      case "plugin_save_state":
        return "aGk=";
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
      case "muscriptor_status":
        return muscriptorStatus();
      case "accept_muscriptor_terms":
        if (!args.rightsConfirmed) {
          throw {
            kind: "audio",
            message: "Confirm that you only use music you have the rights to.",
          };
        }
        window.__muscriptor.terms[args.size] = true;
        window.__muscriptor.rightsConfirmed.push(true);
        return muscriptorStatus();
      case "download_muscriptor_model": {
        const m = window.__muscriptor;
        if (!m.terms[args.size])
          throw { kind: "audio", message: "Accept the MuScriptor terms first." };
        m.downloads.push(args.size);
        window.__emitTauriEvent("muscriptor-model-download-progress", {
          size: args.size,
          fraction: 0.5,
          bytes: MUSCRIPTOR_BYTES[args.size] / 2,
        });
        if (m.hold) {
          await new Promise((resolve, reject) => {
            m.release = resolve;
            m.abort = () => reject({ kind: "audio", message: "Download stopped." });
          });
        }
        if (m.fail) throw { kind: "audio", message: m.fail };
        m.installed[args.size] = true;
        return muscriptorStatus();
      }
      case "cancel_muscriptor_download":
        window.__muscriptor.cancelled += 1;
        window.__muscriptor.abort?.();
        return null;
      case "delete_muscriptor_model":
        window.__muscriptor.deleted.push(args.size);
        window.__muscriptor.installed[args.size] = false;
        return muscriptorStatus();
      case "cancel_transcription":
        window.__transcription.cancelled.push(args.operationId);
        return null;
      case "transcribe_audio":
        // Like Tauri's IPC: the recording is the raw body, its details are headers.
        if (!["mp3", "wav", "flac", "ogg"].includes(options.headers["file-type"])) {
          throw { kind: "audio", message: "Choose MP3, WAV, FLAC or OGG audio." };
        }
        if (
          !window.__muscriptor.terms[options.headers["model-size"]] ||
          !window.__muscriptor.installed[options.headers["model-size"]]
        ) {
          throw { kind: "audio", message: "Download the MuScriptor model first." };
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
          instrument: options.headers["x-instrument"],
          engine: options.headers["x-engine"],
          modelSize: options.headers["x-model-size"],
        });
        if (
          options.headers["x-engine"] === "muscriptor" &&
          (!window.__muscriptor.terms[options.headers["x-model-size"]] ||
            !window.__muscriptor.installed[options.headers["x-model-size"]])
        ) {
          throw { kind: "audio", message: "Download the MuScriptor model first." };
        }
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
        ];
        // A piano take also has a right-hand melody note above middle C.
        if (options.headers["x-instrument"] === "piano") notes.push([72, 0.0, 0.5]);
        // A drum take is hits, with General MIDI drum numbers as the pitch: kick, closed hat,
        // snare, closed hat.
        if (options.headers["x-instrument"] === "drums") {
          return {
            notes: [
              [36, 0.0],
              [42, 0.0],
              [42, 0.5],
              [38, 1.0],
              [42, 1.0],
              [42, 1.5],
            ].map(([pitch, start]) => ({
              pitch,
              start: start + state.shift,
              end: start + state.shift + 0.12,
              velocity: 90,
            })),
          };
        }
        return {
          notes: notes.map(([pitch, start, end]) => ({
            pitch,
            start: start + state.shift,
            end: end + state.shift,
            velocity: 0.8,
          })),
        };
      }
      case "piano_model_status":
        return { installed: window.__pianoModel.installed, bytes: 56799421 };
      case "piano_model_remove":
        window.__pianoModel.removed += 1;
        window.__pianoModel.installed = false;
        return { installed: false, bytes: 56799421 };
      case "download_piano_model":
        window.__pianoModel.downloads += 1;
        window.__emitTauriEvent("piano-model-download-progress", { fraction: 0.5 });
        if (window.__pianoModel.fail) throw { kind: "audio", message: window.__pianoModel.fail };
        window.__pianoModel.installed = true;
        return null;
      case "umx_model_status":
        return stemModelStatus("neural");
      case "stem_model_status":
        return stemModelStatus(args.model);
      case "umx_model_accept_terms":
      case "stem_model_accept_terms":
        window.__stemModels.models[args?.model ?? "neural"].termsAccepted = true;
        return null;
      case "umx_model_download":
      case "stem_model_download":
        return stemModelDownload(args?.model ?? "neural");
      case "umx_model_cancel":
      case "stem_model_cancel":
        window.__stemModels.cancelled += 1;
        window.__stemModels.abort?.();
        return null;
      case "umx_model_remove":
      case "stem_model_remove": {
        const engine = args?.model ?? "neural";
        window.__stemModels.removed.push(engine);
        window.__stemModels.models[engine].downloaded = false;
        return null;
      }
      case "stems_list": {
        // Pinned first, then the most recently opened (or made).
        const seen = (song) => song.lastOpened ?? song.createdAtMs;
        return [...window.__stems.songs].sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || seen(b) - seen(a),
        );
      }
      case "stems_delete":
        window.__stems.songs = window.__stems.songs.filter((song) => song.id !== args.id);
        return null;
      case "take_pending_stem_bundles":
        return [];
      case "stems_touch": {
        const song = window.__stems.songs.find((item) => item.id === args.id);
        if (song) song.lastOpened = window.__stems.clock += 1000;
        return null;
      }
      case "stems_pin": {
        const song = window.__stems.songs.find((item) => item.id === args.id);
        if (song) song.pinned = Boolean(args.pinned);
        return null;
      }
      case "stems_save_bundle": {
        const bundles = window.__stemBundles;
        const { id, dest, includeOriginal } = args.request;
        bundles.saves.push(args.request);
        window.__emitTauriEvent("stems-bundle-progress", { stage: "writing", fraction: 0.5 });
        if (bundles.hold) {
          await new Promise((resolve, reject) => {
            bundles.release = resolve;
            bundles.abort = () => reject({ kind: "io", message: "Saving stopped." });
          });
        }
        if (bundles.fail) throw { kind: "io", message: bundles.fail };
        const song = window.__stems.songs.find((item) => item.id === id);
        if (!song) throw { kind: "audio", message: "These stems are no longer on this computer." };
        const originalIncluded = Boolean(includeOriginal && song.hasOriginal);
        const bytes = song.bytes + (originalIncluded ? 3 * 1024 * 1024 : 0);
        song.savedPath = dest;
        bundles.files[dest] = { ...song, hasOriginal: originalIncluded };
        window.__cloud.meta[dest] = { size: bytes, modified_ms: (window.__stems.clock += 1000) };
        window.__emitTauriEvent("stems-bundle-progress", { stage: "writing", fraction: 1 });
        return { path: dest, bytes, originalIncluded };
      }
      case "stems_open_bundle": {
        const bundles = window.__stemBundles;
        bundles.opens.push(args.path);
        window.__emitTauriEvent("stems-bundle-progress", { stage: "reading", fraction: 0.5 });
        if (bundles.hold) {
          await new Promise((resolve, reject) => {
            bundles.release = resolve;
            bundles.abort = () => reject({ kind: "io", message: "Opening stopped." });
          });
        }
        if (bundles.fail) throw { kind: "io", message: bundles.fail };
        const cloud = window.__cloud;
        if (cloud.placeholders[args.path]) {
          // An online-only file: wait for the drive app to download it.
          window.__emitTauriEvent("cloud-download-waiting", args.path);
          await new Promise((resolve) => (cloud.waiting[args.path] = resolve));
          delete cloud.waiting[args.path];
        }
        const file = bundles.files[args.path];
        if (!file) throw { kind: "io", message: "This is not a Smart Beat stems file." };
        const song = { ...file, savedPath: args.path, lastOpened: (window.__stems.clock += 1000) };
        window.__stems.songs = [
          song,
          ...window.__stems.songs.filter((item) => item.id !== song.id),
        ];
        return song;
      }
      case "cloud_accounts":
        return window.__drives.accounts.map((account) => ({ configured: true, ...account }));
      case "cloud_flush":
      case "cloud_pending":
        return [];
      case "cloud_list": {
        const drives = window.__drives;
        if (drives.listError[args.provider]) throw drives.listError[args.provider];
        return drives.tabs[args.provider] ?? [];
      }
      case "cloud_share": {
        const drives = window.__drives;
        drives.shares.push({ item: args.item, level: args.level });
        if (drives.shareError) {
          const error = drives.shareError;
          drives.shareError = null;
          throw error;
        }
        return `https://share.example.com/${encodeURIComponent(args.item)}?as=${args.level}`;
      }
      case "cloud_create": {
        const drives = window.__drives;
        const provider = options.headers.provider;
        const name = decodeURIComponent(options.headers.name);
        drives.creates.push({ provider, name, bytes: args.byteLength });
        const item = `${provider}:created-${(drives.counter += 1)}`;
        drives.tabs[provider] = [
          { id: item, name, revision: "r1", size: args.byteLength, modified_ms: 1790000000000 },
          ...(drives.tabs[provider] ?? []),
        ];
        return item;
      }
      case "cloud_list_stems": {
        const drives = window.__drives;
        if (drives.listError[args.provider]) throw drives.listError[args.provider];
        return drives.stems[args.provider] ?? [];
      }
      case "stems_cloud_save": {
        const drives = window.__drives;
        const { id, provider, includeOriginal } = args.request;
        drives.saves.push(args.request);
        window.__emitTauriEvent("stems-bundle-progress", { stage: "writing", fraction: 0.5 });
        window.__emitTauriEvent("stems-bundle-progress", { stage: "uploading", fraction: 0.4 });
        await heldDriveTransfer();
        if (drives.fail) {
          const error = drives.fail;
          drives.fail = null;
          throw error;
        }
        const song = window.__stems.songs.find((item) => item.id === id);
        if (!song) throw { kind: "audio", message: "These stems are no longer on this computer." };
        const originalIncluded = Boolean(includeOriginal && song.hasOriginal);
        const bytes = song.bytes + (originalIncluded ? 3 * 1024 * 1024 : 0);
        const item = `${provider}:file-${(drives.counter += 1)}`;
        const name = `${song.name}.sbstems`;
        window.__stemBundles.files[item] = { ...song, hasOriginal: originalIncluded };
        drives.stems[provider] = [
          {
            id: item,
            name,
            revision: "r1",
            size: bytes,
            modified_ms: (window.__stems.clock += 1000),
          },
          ...(drives.stems[provider] ?? []),
        ];
        window.__emitTauriEvent("stems-bundle-progress", { stage: "uploading", fraction: 1 });
        song.savedPath = item;
        return { item, name, provider, bytes, originalIncluded };
      }
      case "stems_cloud_open": {
        const drives = window.__drives;
        const { item } = args.request;
        drives.opens.push(item);
        window.__emitTauriEvent("stems-bundle-progress", { stage: "downloading", fraction: 0.3 });
        await heldDriveTransfer();
        if (drives.fail) {
          const error = drives.fail;
          drives.fail = null;
          throw error;
        }
        const file = window.__stemBundles.files[item];
        if (!file) throw { kind: "not-found", message: "This file could not be found." };
        window.__emitTauriEvent("stems-bundle-progress", { stage: "reading", fraction: 0.5 });
        const song = { ...file, savedPath: item, lastOpened: (window.__stems.clock += 1000) };
        window.__stems.songs = [
          song,
          ...window.__stems.songs.filter((existing) => existing.id !== song.id),
        ];
        return song;
      }
      case "get_cloud_folder":
        return window.__cloud.folder;
      case "set_cloud_folder":
        window.__cloud.folder = args.folder;
        return args.folder;
      case "detect_cloud_folders":
        return [];
      case "list_cloud_scores":
        return window.__cloud.scores;
      case "list_cloud_stems":
        return cloudStems();
      case "stems_cloud_save_path": {
        const cloud = window.__cloud;
        if (!cloud.folder) {
          throw { kind: "not-found", message: "No cloud folder is linked. Link one in Settings." };
        }
        const base =
          String(args.name)
            .replace(/[\\/:*?"<>|]/g, "_")
            .trim() || "stems";
        const taken = (path) => path in window.__stemBundles.files;
        let path = `${cloud.folder}/${base}.sbstems`;
        for (let n = 2; taken(path); n += 1) path = `${cloud.folder}/${base} (${n}).sbstems`;
        cloud.savePaths.push(path);
        return path;
      }
      case "stems_estimate_bundle": {
        const cloud = window.__cloud;
        cloud.estimates.push(args);
        const song = window.__stems.songs.find((item) => item.id === args.id);
        if (!song) throw { kind: "audio", message: "These stems are no longer on this computer." };
        const withOriginal = Boolean(args.includeOriginal && song.hasOriginal);
        return {
          bytes: cloud.estimateBytes ?? song.bytes + (withOriginal ? 3 * 1024 * 1024 : 0),
        };
      }
      case "stems_detect_tempo":
        window.__stems.tempoRequests.push(args.id);
        return window.__stems.tempo;
      case "stems_cache_info":
        return { bytes: 0, count: window.__stems.songs.length, limitBytes: 2 * 1024 ** 3 };
      case "stems_cancel":
        window.__stems.cancelled += 1;
        window.__stems.abort?.();
        window.__drives.abort?.();
        return null;
      case "stems_separate": {
        const stems = window.__stems;
        stems.requests.push(args.request);
        window.__emitTauriEvent("stems-progress", { stage: "reading", fraction: 0.5 });
        window.__emitTauriEvent("stems-progress", { stage: "separating", fraction: 0.5 });
        if (stems.hold) {
          await new Promise((resolve, reject) => {
            stems.release = resolve;
            stems.abort = () => reject({ kind: "audio", message: "Stem separation stopped." });
          });
        }
        if (stems.fail) throw { kind: "audio", message: stems.fail };
        const name = args.request.path
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^.]+$/, "");
        const skipped = stems.mono
          ? args.request.kinds.filter((kind) => kind === "vocals" || kind === "panned")
          : [];
        const kinds = [...args.request.kinds.filter((kind) => !skipped.includes(kind)), "other"];
        const song = {
          id: `${name.replace(/\W/g, "").padEnd(16, "0").slice(0, 16)}`,
          name,
          durationSeconds: STEM_SECONDS,
          sampleRate: 44100,
          engine: args.request.engine,
          strongDrums: args.request.strongDrums,
          stems: kinds.map((kind) => ({ kind, bytes: 192044 })),
          mono: stems.mono,
          skipped,
          pannedShare: 0.3,
          bytes: kinds.length * 192044,
          createdAtMs: (stems.clock += 1000),
          pinned: false,
          lastOpened: null,
          savedPath: null,
          hasOriginal: !stems.originalMissing,
        };
        stems.songs = [song, ...stems.songs.filter((item) => item.id !== song.id)];
        return song;
      }
      case "stems_read":
        window.__stems.reads.push(args);
        return stemWav(STEM_SECONDS, STEM_FREQUENCY[args.kind] ?? 200);
      case "stems_render_mix": {
        window.__stems.renders.push(args.request);
        if (window.__stems.holdRender) {
          await new Promise((resolve) => (window.__stems.releaseRender = resolve));
        }
        return stemWav(STEM_SECONDS / args.request.speed, 200);
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

  /**
   * Practice together (#158): the other players. A host's guests are told apart by connection
   * number (`conn`, 1 unless a test says otherwise; 0 is the link itself). `sent` holds every frame
   * the app sent (decoded; `sentTo` has the connection of each). With `auto` on, a guest behaves
   * like a healthy one: it answers pings with pongs (a 2 ms wire), reports its own sync quality
   * and says ready to every command.
   */
  const together = (window.__practiceTogether = {
    sent: [],
    sentTo: [],
    kicked: [],
    auto: true,
    n: 0,
    /** Called by `practice_send`: records the frame and answers it. */
    receive(text, conn = 1) {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      together.sent.push(frame.msg);
      together.sentTo.push(conn);
      if (!together.auto) return;
      const msg = frame.msg;
      if (msg.type === "ping") {
        setTimeout(() => {
          const t1 = performance.now();
          together.frame({ type: "pong", id: msg.id, t0: msg.t0, t1, t2: t1 }, conn);
          together.frame({ type: "report", errorMs: 2, rtt: 3, driftMs: 0 }, conn);
        }, 1);
      } else if (msg.type === "cmd") {
        setTimeout(() => together.frame({ type: "ready", id: msg.cmd.id, ok: true }, conn), 1);
      }
    },
    /** A frame arriving from the other player on connection `conn`. */
    frame(msg, conn = 1) {
      together.n += 1;
      return window.__emitTauriEvent("practice-frame", {
        conn,
        text: JSON.stringify({ v: 1, n: together.n, msg }),
      });
    },
    /** A connection changing state (a guest arriving or leaving, the link ending). */
    state(state, detail, conn = 1) {
      return window.__emitTauriEvent("practice-state", { conn, state, detail: detail ?? null });
    },
    /** The frames of one type that the app sent (to one connection, when `conn` is given). */
    sentOf(type, conn) {
      return together.sent.filter(
        (m, i) => m.type === type && (conn === undefined || together.sentTo[i] === conn),
      );
    },
  });

  /** Test hook: emit a Tauri event. Returns how many listeners received it. */
  window.__emitTauriEvent = (event, payload) => {
    const ids = listeners.get(event) ?? [];
    for (const id of ids) callbacks.get(id)?.({ event, id, payload });
    return ids.length;
  };

  /** Test hook: simulate the Rust core forwarding a native menu click. */
  window.__emitMenuAction = (action) => window.__emitTauriEvent("menu-action", action);
})();
