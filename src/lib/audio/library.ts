/** Helpers for the user's sound library (see src-tauri/src/audio/library.rs). */

/** Tags typed as "metal, djent" → ["metal", "djent"] (no blanks or repeats, at most 20). */
export const parseTags = (text: string): string[] =>
  [
    ...new Set(
      text
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
