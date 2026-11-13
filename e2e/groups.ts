/**
 * The e2e groups CI runs as separate jobs (one per group and browser), so a slow group never
 * pushes the others past their time limit. "smoke" is every spec that is in no feature group
 * below (the core flows); CI splits it by theme into the `smoke-*` groups (SMOKE_GROUPS, below),
 * and `E2E_GROUP=smoke` still runs all of them together. A feature group lists its specs by glob.
 * Specs for new feature work go into the feature group they belong to, or into a new group: add it
 * here and to the `group` list of the `e2e` job in `.github/workflows/ci.yml` (a test checks that
 * the two lists match and that no spec is in two groups). A new core-flow spec goes into one
 * smoke theme (a test fails until it is in exactly one).
 */
export const FEATURE_GROUPS = {
  "record-import": ["**/record-to-tab.spec.ts", "**/audio-transcription.spec.ts"],
  stems: ["**/stem-separation.spec.ts", "**/stem-cloud.spec.ts", "**/stem-export.spec.ts"],
  "practice-together": ["**/practice-together*.spec.ts"],
  "audio-lanes": ["**/audio-lanes*.spec.ts"],
  edit: [
    "**/tab-line-click.spec.ts",
    "**/selection*.spec.ts",
    "**/paste-over-selection.spec.ts",
    "**/delete-selected-*.spec.ts",
    "**/score-scroll-on-delete.spec.ts",
    "**/editing*.spec.ts",
    "**/drum-overwrite.spec.ts",
    "**/drum-save-reopen.spec.ts",
    "**/structure.spec.ts",
    "**/lyrics-chords.spec.ts",
  ],
  tours: ["**/tour*.spec.ts"],
  "ai-dialogs": ["**/ai-install.spec.ts", "**/model-dialogs.spec.ts"],
  "cloud-share": ["**/cloud-share.spec.ts"],
} as const satisfies Record<string, readonly string[]>;

export type FeatureGroup = keyof typeof FEATURE_GROUPS;

/**
 * The core flows ("smoke") split by theme, one CI job per theme and browser. Every spec that is in
 * no feature group is in exactly one of these (a test checks it). Real-time playback tests live in
 * the score, practice and sound specs, so these jobs run one test at a time.
 */
export const SMOKE_GROUPS = {
  "smoke-ui": [
    "**/responsive.spec.ts",
    "**/accessibility.spec.ts",
    "**/layout.spec.ts",
    "**/dark-score.spec.ts",
    "**/palette-alignment.spec.ts",
    "**/splash.spec.ts",
    "**/toggles.spec.ts",
  ],
  "smoke-files": [
    "**/files.spec.ts",
    "**/export.spec.ts",
    "**/import-formats.spec.ts",
    "**/legacy-gp5.spec.ts",
    "**/credits.spec.ts",
  ],
  "smoke-score": [
    "**/score.spec.ts",
    "**/multi-track.spec.ts",
    "**/tracks.spec.ts",
    "**/instrument-view.spec.ts",
    "**/track-lane-switch.spec.ts",
    "**/extended-range.spec.ts",
    "**/tempo.spec.ts",
  ],
  "smoke-drums": ["**/drum-tab.spec.ts", "**/drum-kits.spec.ts", "**/drum-tab-continuous.spec.ts"],
  "smoke-sound": [
    "**/pedalboard.spec.ts",
    "**/mixer.spec.ts",
    "**/soundfonts.spec.ts",
    "**/effects.spec.ts",
    "**/audio-input.spec.ts",
    "**/monitor.spec.ts",
    "**/sync.spec.ts",
  ],
  "smoke-practice": ["**/practice.spec.ts", "**/practice-view.spec.ts", "**/speed-trainer.spec.ts"],
  "smoke-app": [
    "**/dialogs.spec.ts",
    "**/settings.spec.ts",
    "**/menu.spec.ts",
    "**/updater.spec.ts",
    "**/analytics.spec.ts",
    "**/feedback-90.spec.ts",
  ],
} as const satisfies Record<string, readonly string[]>;

export type SmokeGroup = keyof typeof SMOKE_GROUPS;

/**
 * Every group name CI runs: the smoke themes and the feature groups. `E2E_GROUP` also accepts
 * "smoke" (every smoke theme together) and "additional" (every feature group together).
 */
export const CI_GROUPS: readonly string[] = [
  ...Object.keys(SMOKE_GROUPS),
  ...Object.keys(FEATURE_GROUPS),
];

/** All the feature groups' specs together. */
export const FEATURE_SPECS: string[] = Object.values(FEATURE_GROUPS).flat();
