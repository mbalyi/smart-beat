import type { Channel, InvokeArgs } from "@tauri-apps/api/core";
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
  type MonitorParams,
  type Shortcut,
  type CloudStem,
  type CloudStemFile,
  type StemSong,
  type StemTempo,
  type StemModelId,
  type StemModelStatus,
  type UmxStatus,
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

/** A separated song, as `stems_list` returns it. */
export const STEM_SONG: StemSong = {
  id: "0123456789abcdef",
  name: "Neon Nights",
  durationSeconds: 215,
  sampleRate: 44_100,
  engine: "fast",
  strongDrums: false,
  stems: (["drums", "bass", "vocals", "panned", "other"] as const).map((kind) => ({
    kind,
    bytes: 38_000_000,
  })),
  mono: false,
  skipped: [],
  pannedShare: 0.3,
  bytes: 190_000_000,
  createdAtMs: 1_790_000_000_000,
  pinned: false,
  lastOpened: null,
  savedPath: null,
  hasOriginal: true,
};

/** What `stems_detect_tempo` returns unless a test sets `backend.stemTempo`. */
export const STEM_TEMPO: StemTempo = {
  bpm: 120,
  confidence: 0.9,
  firstBeatSec: 0.5,
  alternatives: [60, 240],
  steady: true,
  sections: [],
};

/** The neural model before anything is downloaded. */
export const UMX_STATUS: UmxStatus = {
  downloaded: false,
  termsAccepted: false,
  termsVersion: 1,
  downloadBytes: 142_551_184,
  licence:
    "The code is MIT. The weights are listed as MIT, and were trained on MUSDB18-HQ, whose terms allow academic and educational use.",
};

/** A model of the `stem_model_*` commands before anything is downloaded. */
export const stemModelStatus = (
  model: StemModelId,
  override: Partial<StemModelStatus> = {},
): StemModelStatus => ({
  model,
  downloaded: false,
  termsAccepted: false,
  termsVersion: 1,
  // The sizes the app pins (src-tauri/src/stems/models.rs); every model is hosted.
  downloadBytes: {
    scnet: 52_271_228,
    "scnet-xl": 216_163_649,
    htdemucs: 176_589_623,
    "htdemucs-6s": 116_246_052,
  }[model],
  licence: `The terms of ${model}: the weights have no stated licence.`,
  licenceSummary: "Weights without a stated licence.",
  available: true,
  ...override,
});
const freshStemModels = (): Record<StemModelId, StemModelStatus> => ({
  scnet: stemModelStatus("scnet"),
  "scnet-xl": stemModelStatus("scnet-xl"),
  htdemucs: stemModelStatus("htdemucs"),
  "htdemucs-6s": stemModelStatus("htdemucs-6s"),
});

type CommandHandler = (args?: InvokeArgs) => unknown;
type MockMonitor = { params: MonitorParams; device: string | null; channel: number | null };

export interface IpcCall {
  cmd: string;
  args?: InvokeArgs;
  /** The invoke options' headers of a raw-body call (`cloud_create` names its provider there). */
  headers?: Record<string, string>;
}

/**
 * State behind the mocked Rust commands: files on "disk", saved mixes, and
 * what the Open dialog returns. Reset by {@link mockTauri}.
 */
export const backend = {
  pluginsEnabled: false,
  monitor: null as { params: MonitorParams; device: string | null; channel: number | null } | null,
  files: new Map<string, Uint8Array>(),
  mixes: new Map<string, MixerSettings>(),
  /** Path the Open dialog picks, or `null` for Cancel. */
  dialogResult: null as string | null,
  /** The linked cloud folder `get_cloud_folder` returns (none by default). */
  cloudFolder: null as string | null,
  /** The `.sbstems` files `list_cloud_stems` returns (newest first). */
  cloudStems: [] as CloudStem[],
  /** The `.sbstems` files `cloud_list_stems` returns for each connected account (newest first). */
  driveStems: {} as Record<string, CloudStemFile[]>,
  /** The tabs `cloud_list` returns for each connected account (newest first). */
  driveTabs: {} as Record<string, CloudStemFile[]>,
  /** What `cloud_accounts` returns (none connected by default). */
  cloudAccounts: [] as {
    provider: string;
    label: string;
    /** Defaults to true (a build with credentials). */
    configured?: boolean;
    account: string | null;
    /** The link levels the service makes (view only when left out). */
    shareLevels?: string[];
  }[],
  /** The last menu state the UI sent. */
  menuState: null as MenuState | null,
  /** Recently opened songs, most recent first (see `src-tauri/src/recent.rs`). */
  recent: [] as string[],
  /** Songs the system asked to open that the page has not collected (`src-tauri/src/open_file.rs`). */
  pendingOpen: [] as string[],
  /** Path the Save dialog picks, or `null` for Cancel. */
  saveResult: null as string | null,
  /** Files written by `write_score_file`, by path. */
  written: new Map<string, Uint8Array>(),
  /** Headers of the last `write_score_file` (the destination, and the expected hash). */
  lastWriteHeaders: undefined as Record<string, string> | undefined,
  /** Settings stored inside saved `.gp` files, by path. */
  projectSettings: new Map<string, MixerSettings>(),
  /** Usage counter settings (see `src-tauri/src/telemetry.rs`); builds without an endpoint have none. */
  usage: { enabled: true, available: false, noticeSeen: true },
  /** The separated songs `stems_list` returns (newest first). */
  stemSongs: [] as StemSong[],
  /** `.sbstems` paths the system opened before the page was listening (the Rust queue). */
  pendingStemBundles: [] as string[],
  /** What `stems_detect_tempo` returns. */
  stemTempo: { ...STEM_TEMPO } as StemTempo,
  /** What `umx_model_status` returns. */
  umx: { ...UMX_STATUS } as UmxStatus,
  /** The song `stems_open_bundle` returns. */
  bundleSong: { ...STEM_SONG, id: "bbbbbbbbbbbbbbbb", name: "Opened Song" } as StemSong,
  /** What `stem_model_status` returns, by model. */
  stemModels: freshStemModels(),
  /** The update the updater plugin finds, or `null` when this is the latest version. */
  update: null as { version: string; body?: string } | null,
  /** Makes `check` or the download fail with this message. */
  updateError: null as { during: "check" | "install"; message: string } | null,
  /** Size of the fake download, in bytes (sent as three equal chunks). */
  updateBytes: 3000,
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
  backend.pluginsEnabled = false;
  backend.monitor = null;
  backend.files.clear();
  backend.mixes.clear();
  backend.dialogResult = null;
  backend.cloudAccounts = [];
  backend.cloudFolder = null;
  backend.cloudStems = [];
  backend.menuState = null;
  backend.recent = [];
  backend.pendingOpen = [];
  backend.saveResult = null;
  backend.written.clear();
  backend.projectSettings.clear();
  backend.usage = { enabled: true, available: false, noticeSeen: true };
  backend.stemSongs = [];
  backend.bundleSong = { ...STEM_SONG, id: "bbbbbbbbbbbbbbbb", name: "Opened Song" };
  backend.pendingStemBundles = [];
  backend.stemTempo = { ...STEM_TEMPO };
  backend.umx = { ...UMX_STATUS };
  backend.stemModels = freshStemModels();
  backend.update = null;
  backend.updateError = null;
  backend.updateBytes = 3000;
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args, headers: lastOptions?.headers });
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
        case "take_pending_open_files":
          return backend.pendingOpen.splice(0);
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
        // `export_m4a` encodes the WAV it is sent as AAC; the mock keeps the WAV.
        case "export_m4a":
        case "write_score_file": {
          // Raw body (bytes) plus the URI-encoded destination in a header.
          const path = decodeURIComponent(lastOptions?.headers?.path ?? "");
          backend.lastWriteHeaders = lastOptions?.headers;
          backend.written.set(path, new Uint8Array(args as ArrayBuffer | Uint8Array));
          return null;
        }
        case "export_pdf":
          return null;
        // Practice together (#158): no other player in unit tests.
        case "practice_host":
          return {
            code: "ABCD-EFGH-JKMN-PQRS-TVWX",
            link: "smartbeat://join/ABCD-EFGH-JKMN-PQRS-TVWX",
            address: "192.168.1.5:50123",
          };
        case "practice_join":
        case "practice_kick":
        case "practice_leave":
        case "practice_signal_join":
        case "practice_signal_send":
        case "practice_signal_kick":
        case "practice_signal_leave":
          return null;
        case "practice_send":
          return true;
        case "practice_signal_available":
          return false;
        case "practice_signal_create":
          return "ABCD-EFGH";
        case "track_event":
          return null;
        // No folder linked and none detected; no cloud accounts or pending uploads (#187).
        case "get_cloud_folder":
          return backend.cloudFolder;
        case "list_cloud_stems":
          return backend.cloudStems;
        // Mirrors the Rust command: a path in the linked folder, "not-found" without one.
        case "stems_cloud_save_path": {
          if (!backend.cloudFolder) return fail("not-found", "No cloud folder is linked.");
          return `${backend.cloudFolder}/${(args as { name: string }).name}.sbstems`;
        }
        // An estimate: the original adds 25 MB to the stems.
        case "stems_estimate_bundle":
          return {
            bytes: (args as { includeOriginal: boolean }).includeOriginal
              ? 80 * 1024 * 1024
              : 55 * 1024 * 1024,
          };
        case "cloud_accounts":
          return backend.cloudAccounts.map((a) => ({ configured: true, ...a }));
        case "cloud_list":
          return backend.driveTabs[(args as { provider: string }).provider] ?? [];
        case "cloud_list_stems":
          return backend.driveStems[(args as { provider: string }).provider] ?? [];
        // Saving to an account: the file is named after the song, as the Rust command does.
        case "stems_cloud_save": {
          const { id, provider, includeOriginal } = (
            args as {
              request: { id: string; provider: string; includeOriginal: boolean };
            }
          ).request;
          const name = backend.stemSongs.find((song) => song.id === id)?.name ?? STEM_SONG.name;
          return {
            item: `${provider}:1`,
            name: `${name}.sbstems`,
            provider,
            bytes: 24_000_000,
            originalIncluded: includeOriginal,
          };
        }
        case "stems_cloud_open": {
          const { item } = (args as { request: { item: string } }).request;
          const opened = { ...backend.bundleSong, savedPath: item };
          backend.stemSongs = [opened, ...backend.stemSongs.filter((s) => s.id !== opened.id)];
          return opened;
        }
        // A share link is made by the service: the mock gives one that names what was asked.
        case "cloud_share": {
          const { item, level } = args as { item: string; level: string };
          return `https://share.example.com/${encodeURIComponent(item)}?as=${level}`;
        }
        case "detect_cloud_folders":
        case "cloud_pending":
        case "cloud_flush":
          return [];
        case "cloud_disconnect":
          return null;
        // Stem separation (#186). Tests override `stems_separate`, `stems_read` and
        // `stems_render_mix` to play a part.
        case "stems_list":
          return backend.stemSongs;
        case "stems_delete":
          backend.stemSongs = backend.stemSongs.filter(
            (song) => song.id !== (args as { id: string }).id,
          );
          return null;
        case "take_pending_stem_bundles":
          return backend.pendingStemBundles.splice(0);
        case "stems_touch":
        case "stems_pin": {
          const { id, pinned } = args as { id: string; pinned?: boolean };
          backend.stemSongs = backend.stemSongs.map((song) =>
            song.id !== id
              ? song
              : cmd === "stems_pin"
                ? { ...song, pinned: pinned ?? false }
                : { ...song, lastOpened: Date.now() },
          );
          return null;
        }
        // Saving writes the file at `dest` and marks the song as saved there; opening a file
        // returns the song (tests set `backend.bundleSong`) as saved at that path.
        case "stems_save_bundle": {
          const { id, dest, includeOriginal } = (
            args as { request: { id: string; dest: string; includeOriginal: boolean } }
          ).request;
          backend.stemSongs = backend.stemSongs.map((song) =>
            song.id === id ? { ...song, savedPath: dest } : song,
          );
          return { path: dest, bytes: 24_000_000, originalIncluded: includeOriginal };
        }
        case "stems_open_bundle": {
          const opened = { ...backend.bundleSong, savedPath: (args as { path: string }).path };
          backend.stemSongs = [opened, ...backend.stemSongs.filter((s) => s.id !== opened.id)];
          return opened;
        }
        case "stems_detect_tempo":
          return backend.stemTempo;
        case "stems_cache_info":
          return {
            bytes: backend.stemSongs.reduce((sum, song) => sum + song.bytes, 0),
            count: backend.stemSongs.length,
            limitBytes: 2 * 1024 ** 3,
          };
        case "stems_cancel":
        case "umx_model_cancel":
        case "umx_model_accept_terms":
          if (cmd === "umx_model_accept_terms") backend.umx.termsAccepted = true;
          return null;
        case "umx_model_status":
          return backend.umx;
        case "stem_model_cancel":
          return null;
        case "stem_model_accept_terms":
          backend.stemModels[(args as { model: StemModelId }).model].termsAccepted = true;
          return null;
        case "stem_model_status":
          return backend.stemModels[(args as { model: StemModelId }).model];
        case "stem_model_remove":
          backend.stemModels[(args as { model: StemModelId }).model].downloaded = false;
          return null;
        case "umx_model_remove":
          backend.umx.downloaded = false;
          return null;
        case "get_usage_settings":
          return backend.usage;
        case "set_usage_settings": {
          const { enabled, noticeSeen } = args as {
            enabled: boolean | null;
            noticeSeen: boolean | null;
          };
          backend.usage = {
            ...backend.usage,
            enabled: enabled ?? backend.usage.enabled,
            noticeSeen: noticeSeen ?? backend.usage.noticeSeen,
          };
          return backend.usage;
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
        // The updater plugin: `check` finds `backend.update`, and the install reports progress
        // through the channel the plugin passes in, like the Rust side.
        case "plugin:updater|check": {
          if (backend.updateError?.during === "check") throw backend.updateError.message;
          if (!backend.update) return null;
          return {
            rid: 7,
            currentVersion: APP_INFO.version,
            version: backend.update.version,
            date: "2026-11-01T00:00:00Z",
            body: backend.update.body,
            rawJson: {},
          };
        }
        case "plugin:updater|download_and_install": {
          const { onEvent } = args as { onEvent: Channel<unknown> };
          const send = (message: unknown) => onEvent.onmessage(message);
          send({ event: "Started", data: { contentLength: backend.updateBytes } });
          for (let i = 0; i < 3; i++) {
            send({ event: "Progress", data: { chunkLength: backend.updateBytes / 3 } });
          }
          if (backend.updateError?.during === "install") throw backend.updateError.message;
          send({ event: "Finished" });
          return null;
        }
        case "plugin:opener|open_url":
        case "plugin:opener|reveal_item_in_dir":
        case "plugin:process|restart":
        case "plugin:resources|close":
          return null;
        // The sound library starts empty; the native engine is never started here.
        case "library_list":
          return [];
        case "plugins_enabled":
          return backend.pluginsEnabled;
        case "plugins_set_enabled":
          backend.pluginsEnabled = (args as { enabled: boolean }).enabled;
          return null;
        case "plugins_scan":
          return { plugins: [], skipped: [] };
        case "audio_plugin_info":
          return [];
        // No drum kits imported (#40); tests override these to have some.
        case "kits_list":
          return [];
        case "kits_remove":
        case "audio_set_track_kit":
          return null;
        case "audio_input_channels":
          return 2;
        // Opening a file for the lanes only decodes it: no engine is involved (a 4 s file whose
        // content id follows its name).
        case "audio_load_source": {
          const { location } = args as {
            location: { type: "file"; path: string } | { type: "embedded"; entry: string };
          };
          const path = location.type === "file" ? location.path : location.entry;
          const name = path.split(/[\\/]/).pop() ?? path;
          let hash = 7;
          for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
          return {
            id: hash.toString(16).padStart(8, "0").repeat(8),
            name,
            ext: name.split(".").pop()?.toLowerCase() ?? "wav",
            durationMs: 4000,
            sampleRate: 44100,
            channels: 2,
            peaks: [0.4, 0.8, 0.5, 0.9],
            peaksPerSecond: 1,
          };
        }
        // One quiet second, 1 s into every file; tests override it for other shapes.
        case "audio_silent_regions":
          return [{ startMs: 1000, endMs: 2000 }];
        case "audio_set_monitor":
          backend.monitor = (args as { monitor: MockMonitor | null }).monitor;
          return backend.monitor
            ? {
                open: backend.monitor.params.enabled,
                device: backend.monitor.device ?? "System default",
                channels: 2,
                sampleRate: 48000,
                latencyMs: 5,
                error: null,
              }
            : null;
        case "audio_set_monitor_chain":
          return [];
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
        case "cloud_embed_project":
          // The song itself, unchanged: the real command stores the mix inside it.
          return new Uint8Array(args as Uint8Array).buffer;
        case "cloud_project_settings":
          return null;
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

/** Simulates the system handing songs to the app: they are queued, then the page is told. */
export async function emitOpenExternalFiles(paths: string[]) {
  backend.pendingOpen.push(...paths);
  await emit("open-external-file");
}

/** Simulates the system opening a `.sbstems` file: the core sends its path. */
export async function emitStemBundleOpened(path: string) {
  await emit("stems-bundle-opened", { path });
}

/** Simulates the OS dragging files onto the window (Tauri webview events). */
export async function emitFileDrag(
  event:
    | { type: "enter"; paths: string[] }
    | { type: "leave" }
    | { type: "drop"; paths: string[]; position?: { x: number; y: number } },
) {
  const position = (event.type === "drop" && event.position) || { x: 10, y: 10 };
  if (event.type === "leave") await emit("tauri://drag-leave", null);
  else await emit(`tauri://drag-${event.type}`, { paths: event.paths, position });
}
