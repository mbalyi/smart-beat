/**
 * The e2e groups CI runs as separate jobs (one per group and browser), so a slow group never
 * pushes the others past their time limit. "smoke" is every spec that is in no feature group
 * below (the core flows); a feature group lists its specs by glob. Specs for new feature work go
 * into the feature group they belong to, or into a new group: add it here and to the `group` list
 * of the `e2e` job in `.github/workflows/ci.yml` (a test checks that the two lists match and that
 * no spec is in two groups).
 */
export const FEATURE_GROUPS = {
  "record-import": ["**/record-to-tab.spec.ts", "**/audio-transcription.spec.ts"],
  stems: ["**/stem-separation.spec.ts", "**/stem-cloud.spec.ts"],
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

/** Every group name CI runs: "smoke" (all the rest) and the feature groups. */
export const CI_GROUPS: readonly string[] = ["smoke", ...Object.keys(FEATURE_GROUPS)];

/** All the feature groups' specs together. */
export const FEATURE_SPECS: string[] = Object.values(FEATURE_GROUPS).flat();
