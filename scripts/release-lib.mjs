// Pure helpers for the release workflow (.github/workflows/release.yml). The CLI wrappers are
// release-notes.mjs and verify-latest-json.mjs; the tests are in release-lib.test.mjs.

/** Platforms the updater manifest (`latest.json`) must cover, as `<os>-<arch>`. */
export const UPDATER_TARGETS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "linux-x86_64",
];

/** Where release assets live. The updater and the website only trust this repository. */
export const RELEASE_URL_PREFIX = "https://github.com/mbalyi/smart-beat/releases/download/";

/** `v0.2.0` -> `0.2.0`. Throws when the tag is not `v<semver>`. */
export function versionFromTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
  if (!match) throw new Error(`"${tag}" is not a release tag like v1.2.3`);
  return match[1];
}

/** Fails when the tag and the app version (package.json) disagree: one canonical version. */
export function assertTagMatchesVersion(tag, version) {
  const fromTag = versionFromTag(tag);
  if (fromTag !== version) {
    throw new Error(`Tag ${tag} does not match the app version ${version} in package.json.`);
  }
}

/**
 * The part of CHANGELOG.md for `version`: the text under `## [<version>]` (with an optional
 * date after it) up to the next `## ` heading. Throws when there is no such section or it is empty.
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for version ${version}.`);

  let end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;

  const notes = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  if (!notes) throw new Error(`The CHANGELOG.md section for ${version} is empty.`);
  return notes;
}

/**
 * Checks an updater manifest. Returns a list of problems (empty when it is fine): the version
 * must be the expected one, and every target needs a signature and a download URL that points at
 * this repository's release for that tag.
 */
export function verifyLatestJson(manifest, { tag, version }) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["latest.json is not a JSON object."];

  if (manifest.version !== version) {
    problems.push(`version is ${JSON.stringify(manifest.version)}, expected ${version}.`);
  }
  if (typeof manifest.notes !== "string" || manifest.notes.trim() === "") {
    problems.push("notes are missing, so the update dialog would have nothing to show.");
  }

  const platforms = manifest.platforms ?? {};
  for (const target of UPDATER_TARGETS) {
    const entry = findPlatform(platforms, target);
    if (!entry) {
      problems.push(`${target}: no entry.`);
      continue;
    }
    if (typeof entry.signature !== "string" || entry.signature.trim() === "") {
      problems.push(`${target}: signature is missing.`);
    }
    const expectedPrefix = `${RELEASE_URL_PREFIX}${tag}/`;
    if (typeof entry.url !== "string" || !entry.url.startsWith(expectedPrefix)) {
      problems.push(`${target}: url must start with ${expectedPrefix} (got ${entry.url}).`);
    }
  }
  return problems;
}

/**
 * Tauri writes both `<os>-<arch>` and `<os>-<arch>-<bundle>` keys (for example `darwin-aarch64`
 * and `darwin-aarch64-app`). Either form counts.
 */
function findPlatform(platforms, target) {
  if (platforms[target]) return platforms[target];
  const key = Object.keys(platforms).find((name) => name.startsWith(`${target}-`));
  return key ? platforms[key] : undefined;
}
