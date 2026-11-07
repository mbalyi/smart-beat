/**
 * Fixed categories for the `error` usage counter (docs/analytics.md, #164). A failed command is
 * counted as `<area>:<kind>`; neither the command name nor the message is ever sent.
 *
 * This module imports nothing from the Tauri bridge or the telemetry module, so both can use it.
 */

/** Where a failure is filed. Mirrors `ERROR_AREAS` in `src-tauri/src/telemetry.rs`. */
export const ERROR_AREAS = [
  "file",
  "export",
  "audio",
  "plugin",
  "import",
  "ai",
  "stems",
  "cloud",
  "practice",
  "settings",
  "other",
] as const;
export type ErrorArea = (typeof ERROR_AREAS)[number];

/**
 * What kind of failure it was: every `ErrorKind` of the Rust core in its wire spelling, plus
 * `unknown` for a rejection without a kind. Mirrors `ERROR_KINDS` in `telemetry.rs`.
 */
export const ERROR_KINDS = [
  "not-found",
  "unsupported-type",
  "too-large",
  "not-a-score",
  "invalid-key",
  "invalid-settings",
  "invalid-menu-state",
  "audio",
  "conflict",
  "download-timeout",
  "network",
  "auth-expired",
  "invalid-code",
  "io",
  "unknown",
] as const;
export type ErrorKindName = (typeof ERROR_KINDS)[number];

/** Every `error` detail: each area with each kind. */
export const ERROR_DETAILS: readonly string[] = ERROR_AREAS.flatMap((area) =>
  ERROR_KINDS.map((kind) => `${area}:${kind}`),
);

/** Commands that are never counted: reporting their failure would report itself. */
const UNCOUNTED = new Set(["track_event", "get_usage_settings", "set_usage_settings"]);

/** Command-name prefixes (and exact names) per area; the first match wins. */
const AREA_RULES: ReadonlyArray<readonly [ErrorArea, RegExp]> = [
  ["plugin", /^(plugins?_|audio_plugin_)/],
  ["audio", /^(audio_|library_|soundfonts_|kits_)/],
  ["export", /^export_/],
  ["cloud", /^(cloud_|list_cloud_|stems_cloud_)|cloud_folder/],
  ["stems", /^(stems_|umx_model_|stem_model_)/],
  ["practice", /^practice_/],
  ["import", /^(transcribe_audio|cancel_transcription|read_transcription_audio)$/],
  [
    "ai",
    /^(transcribe_recording|cancel_recording_transcription|muscriptor_|accept_muscriptor_|download_muscriptor_|cancel_muscriptor_|delete_muscriptor_|piano_model_|download_piano_model)/,
  ],
  [
    "file",
    /^take_pending_|^(read_score_file|write_score_file|score_file_stamp|load_recent_files|add_recent_file|remove_recent_file|clear_recent_files)$/,
  ],
  [
    "settings",
    /^(app_info|menu_shortcuts|update_menu_state|load_mixer_settings|save_mixer_settings|read_project_settings|write_project_settings)$/,
  ],
];

/** The area a command belongs to, from its name. Unknown commands are `other`. */
export function areaOf(command: string): ErrorArea {
  for (const [area, rule] of AREA_RULES) {
    if (rule.test(command)) return area;
  }
  return "other";
}

/** The kind of a rejection: a Rust `CommandError` carries one, anything else is `unknown`. */
export function kindOf(error: unknown): ErrorKindName {
  const kind =
    typeof error === "object" && error !== null ? (error as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && (ERROR_KINDS as readonly string[]).includes(kind)
    ? (kind as ErrorKindName)
    : "unknown";
}

/**
 * The `error` counter detail for a failed command, or `null` when it is not counted. Reads only
 * the fixed `kind` of the rejection, never its message.
 */
export function errorDetail(command: string, error: unknown): string | null {
  if (UNCOUNTED.has(command)) return null;
  return `${areaOf(command)}:${kindOf(error)}`;
}
