// License policy shared by the npm checks and mirrored in deny.toml / about.toml.
// Rationale: docs/licensing.md and docs/adr/0001-project-license.md.

/** Licenses compatible with distributing Smart Beat as closed-source freeware. */
export const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC-BY-4.0", // attribution only; used by data packages such as caniuse-lite
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0", // file-level copyleft: unmodified use is fine, changed files must be published
  "OFL-1.1", // fonts (Geist): may be embedded in any software, just not sold on their own
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib",
]);

/** `WITH` exceptions that only relax the base license. */
export const ALLOWED_EXCEPTIONS = new Set(["LLVM-exception"]);

/**
 * Packages whose license metadata is missing or non-standard, reviewed by hand.
 * Key: package name, value: the license that actually applies.
 */
export const REVIEWED_PACKAGES = new Map([]);

/**
 * Build-time packages whose output is embedded in the shipped bundle even
 * though they are devDependencies (generated CSS).
 */
export const EMBEDDED_BUILD_PACKAGES = [
  "tailwindcss",
  "shadcn",
  "tw-animate-css",
  // Injects worker/worklet bootstrap code into the bundle.
  "@coderline/alphatab-vite",
];

/**
 * Evaluates an SPDX expression such as `(MIT OR Apache-2.0)` or
 * `MIT AND Zlib` against the allowlist.
 */
export function isAllowed(expression) {
  if (!expression) return false;
  const alternatives = expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .map((alt) => alt.trim())
    .filter(Boolean);

  return alternatives.some((alternative) =>
    alternative
      .split(/\s+AND\s+/i)
      .map((term) => term.trim())
      .every((term) => {
        const [license, exception] = term.split(/\s+WITH\s+/i);
        return ALLOWED_LICENSES.has(license) && (!exception || ALLOWED_EXCEPTIONS.has(exception));
      }),
  );
}
