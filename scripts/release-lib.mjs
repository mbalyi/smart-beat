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

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `1.2.3-beta.1` -> `{ major: 1, minor: 2, patch: 3, prerelease: "beta.1" }`. Throws on anything else. */
export function parseVersion(version) {
  const match = SEMVER.exec(version ?? "");
  if (!match) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-beta.1`);
  const [, major, minor, patch, prerelease] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

/** Whether a version or tag is a prerelease (`0.2.0-beta.1`), which never goes to the stable channel. */
export function isPrerelease(versionOrTag) {
  return Boolean(parseVersion(String(versionOrTag).replace(/^v/, "")).prerelease);
}

/** Semantic-version order: negative when `a` is older than `b`. A prerelease is older than its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const part of ["major", "minor", "patch"]) {
    if (x[part] !== y[part]) return x[part] - y[part];
  }
  if (x.prerelease === y.prerelease) return 0;
  if (!x.prerelease) return 1;
  if (!y.prerelease) return -1;
  const xs = x.prerelease.split(".");
  const ys = y.prerelease.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const numeric = /^\d+$/.test(xs[i]) && /^\d+$/.test(ys[i]);
    const order = numeric ? Number(xs[i]) - Number(ys[i]) : xs[i].localeCompare(ys[i]);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * The next version: `patch`, `minor` or `major`, or an explicit version that must be newer.
 * A prerelease bumped by `patch` becomes its release (`0.2.0-beta.1` -> `0.2.0`).
 */
export function nextVersion(current, kind) {
  const { major, minor, patch, prerelease } = parseVersion(current);
  let next;
  if (kind === "major") next = `${major + 1}.0.0`;
  else if (kind === "minor") next = `${major}.${minor + 1}.0`;
  else if (kind === "patch")
    next = prerelease ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
  else next = kind;
  if (compareVersions(next, current) <= 0) {
    throw new Error(`${next} is not newer than the current version ${current}.`);
  }
  return next;
}

/**
 * Starts the CHANGELOG.md section for a release: the `## [Unreleased]` notes become
 * `## [<version>]`, and a new, empty `## [Unreleased]` goes above it.
 */
export function releaseChangelog(changelog, version) {
  const heading = /^## \[Unreleased\][^\n]*\n/m;
  if (!heading.test(changelog)) throw new Error("CHANGELOG.md has no ## [Unreleased] section.");
  if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }
  return changelog.replace(heading, `## [Unreleased]\n\n## [${version}]\n`);
}

/** Problems when the version-bearing files disagree with package.json (the canonical version). */
export function checkVersionFiles({ packageJson, cargoToml, cargoLock, tauriConf }) {
  const version = JSON.parse(packageJson).version;
  const problems = [];
  try {
    parseVersion(version);
  } catch (error) {
    return [`package.json: ${error.message}`];
  }
  const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
  if (cargo !== version) {
    problems.push(`src-tauri/Cargo.toml: version is ${cargo}, package.json says ${version}.`);
  }
  const locked = /^name = "smart-beat"\nversion = "([^"]+)"/m.exec(cargoLock)?.[1];
  if (locked !== version) {
    problems.push(`src-tauri/Cargo.lock: smart-beat is ${locked}, package.json says ${version}.`);
  }
  const msi = JSON.parse(tauriConf).bundle?.windows?.wix?.version;
  const expected = msiVersion(version);
  if (msi !== expected) {
    problems.push(
      `src-tauri/tauri.conf.json: bundle.windows.wix.version is ${msi}, expected ${expected} for ${version}.`,
    );
  }
  return problems;
}

/** The same files with the version set to `version`. */
export function setVersion({ packageJson, cargoToml, cargoLock, tauriConf }, version) {
  parseVersion(version);
  return {
    tauriConf: tauriConf.replace(
      /("wix":\s*\{\s*"version":\s*")[^"]+(")/,
      `$1${msiVersion(version)}$2`,
    ),
    packageJson: packageJson.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
    cargoToml: cargoToml.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
    cargoLock: cargoLock.replace(/^(name = "smart-beat"\nversion = ")[^"]+(")/m, `$1${version}$2`),
  };
}

const INSTALLER_EXTENSIONS = [".dmg", ".exe", ".msi", ".AppImage", ".deb", ".rpm"];
const PLATFORM_NAMES = { macos: "macOS", darwin: "macOS", windows: "Windows", linux: "Linux" };

/**
 * The versioned copy of a stable installer name, or null for files that are not installers
 * (updater bundles, signatures, latest.json):
 * `SmartBeat_macos_universal.dmg` -> `SmartBeat-0.2.0-macOS-universal.dmg`.
 */
export function versionedAssetName(stableName, version) {
  parseVersion(version);
  if (!INSTALLER_EXTENSIONS.some((extension) => stableName.endsWith(extension))) return null;
  const match = /^SmartBeat_([A-Za-z]+)_(.+)$/.exec(stableName);
  if (!match) return null;
  const platform = PLATFORM_NAMES[match[1].toLowerCase()] ?? match[1];
  return `SmartBeat-${version}-${platform}-${match[2]}`;
}

const PRERELEASE_OFFSETS = { alpha: 1000, beta: 2000, rc: 3000 };

/**
 * The Windows MSI version for an app version. MSI only takes numbers (`major.minor.build.revision`,
 * revision up to 65535), so Tauri cannot derive it from `1.0.0-beta.1`. A release keeps its own
 * version; a prerelease puts its label and number in the fourth field: alpha.N → 1000+N,
 * beta.N → 2000+N, rc.N → 3000+N (`1.0.0-beta.1` → `1.0.0.2001`).
 */
export function msiVersion(version) {
  const { major, minor, patch, prerelease } = parseVersion(version);
  if (major > 255 || minor > 255) throw new Error(`${version} is too large for an MSI version.`);
  if (!prerelease) return `${major}.${minor}.${patch}`;
  const match = /^(alpha|beta|rc)(?:\.(\d+))?$/.exec(prerelease);
  if (!match)
    throw new Error(`Prerelease "${prerelease}" must be alpha.N, beta.N or rc.N for Windows.`);
  const number = Number(match[2] ?? 0);
  if (number > 999) throw new Error(`Prerelease number ${number} is too large for an MSI version.`);
  return `${major}.${minor}.${patch}.${PRERELEASE_OFFSETS[match[1]] + number}`;
}
