import { describe, expect, it } from "vitest";

import {
  assertTagMatchesVersion,
  checkVersionFiles,
  compareVersions,
  extractReleaseNotes,
  isPrerelease,
  msiVersion,
  nextVersion,
  parseVersion,
  RELEASE_URL_PREFIX,
  releaseChangelog,
  setVersion,
  UPDATER_TARGETS,
  verifyLatestJson,
  versionedAssetName,
  versionFromTag,
} from "./release-lib.mjs";

describe("versionFromTag", () => {
  it("strips the v", () => {
    expect(versionFromTag("v0.2.0")).toBe("0.2.0");
    expect(versionFromTag("v1.0.0-beta.1")).toBe("1.0.0-beta.1");
  });

  it.each(["0.2.0", "v1.2", "release-1", "", undefined])("rejects %j", (tag) => {
    expect(() => versionFromTag(tag)).toThrow(/not a release tag/);
  });
});

describe("assertTagMatchesVersion", () => {
  it("accepts a matching tag", () => {
    expect(() => assertTagMatchesVersion("v0.1.0", "0.1.0")).not.toThrow();
  });

  it("names both versions when they differ", () => {
    expect(() => assertTagMatchesVersion("v0.2.0", "0.1.0")).toThrow(
      "Tag v0.2.0 does not match the app version 0.1.0 in package.json.",
    );
  });
});

describe("extractReleaseNotes", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- Not yet.",
    "",
    "## [0.2.0] - 2026-11-01",
    "",
    "### Added",
    "- Update dialog.",
    "",
    "## [0.1.0] - 2026-10-08",
    "",
    "- First release.",
    "",
  ].join("\n");

  it("returns only the section of the requested version", () => {
    expect(extractReleaseNotes(changelog, "0.2.0")).toBe("### Added\n- Update dialog.");
    expect(extractReleaseNotes(changelog, "0.1.0")).toBe("- First release.");
  });

  it("does not mix up 0.1.0 with 10.1.0", () => {
    const text = "## [10.1.0]\n\n- ten\n\n## [0.1.0]\n\n- one\n";
    expect(extractReleaseNotes(text, "0.1.0")).toBe("- one");
  });

  it("accepts CRLF line endings and headings without brackets", () => {
    expect(extractReleaseNotes("## 0.3.0\r\n\r\n- Works.\r\n", "0.3.0")).toBe("- Works.");
  });

  it("fails when the version has no section", () => {
    expect(() => extractReleaseNotes(changelog, "9.9.9")).toThrow(/no section for version 9.9.9/);
  });

  it("fails when the section is empty", () => {
    expect(() => extractReleaseNotes("## [0.4.0]\n\n## [0.3.0]\n- x\n", "0.4.0")).toThrow(
      /is empty/,
    );
  });
});

describe("verifyLatestJson", () => {
  const tag = "v0.2.0";
  const version = "0.2.0";
  const entry = (name) => ({
    signature: "dW50cnVzdGVk",
    url: `${RELEASE_URL_PREFIX}${tag}/${name}`,
  });
  const good = () => ({
    version,
    notes: "- Update dialog.",
    platforms: {
      "darwin-aarch64": entry("SmartBeat_darwin_universal.app.tar.gz"),
      "darwin-x86_64": entry("SmartBeat_darwin_universal.app.tar.gz"),
      "windows-x86_64": entry("SmartBeat_windows_x64-setup.exe"),
      "linux-x86_64": entry("SmartBeat_linux_amd64.AppImage"),
    },
  });

  it("covers every updater target", () => {
    expect(UPDATER_TARGETS).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-x86_64",
      "linux-x86_64",
    ]);
  });

  it("accepts a complete manifest", () => {
    expect(verifyLatestJson(good(), { tag, version })).toEqual([]);
  });

  it("accepts the bundle-suffixed keys Tauri also writes", () => {
    const manifest = good();
    manifest.platforms["linux-x86_64-appimage"] = manifest.platforms["linux-x86_64"];
    delete manifest.platforms["linux-x86_64"];
    expect(verifyLatestJson(manifest, { tag, version })).toEqual([]);
  });

  it("reports a missing target", () => {
    const manifest = good();
    delete manifest.platforms["windows-x86_64"];
    expect(verifyLatestJson(manifest, { tag, version })).toEqual(["windows-x86_64: no entry."]);
  });

  it("reports a missing or blank signature", () => {
    const manifest = good();
    manifest.platforms["linux-x86_64"].signature = " ";
    delete manifest.platforms["darwin-aarch64"].signature;
    expect(verifyLatestJson(manifest, { tag, version })).toEqual([
      "darwin-aarch64: signature is missing.",
      "linux-x86_64: signature is missing.",
    ]);
  });

  it("rejects download URLs outside this repository's release", () => {
    const manifest = good();
    manifest.platforms["darwin-x86_64"].url = "https://example.com/SmartBeat.app.tar.gz";
    manifest.platforms["linux-x86_64"].url = `${RELEASE_URL_PREFIX}v0.1.0/old.AppImage`;
    const problems = verifyLatestJson(manifest, { tag, version });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^darwin-x86_64: url must start with /);
    expect(problems[1]).toMatch(/^linux-x86_64: url must start with /);
  });

  it("rejects a wrong version and missing notes", () => {
    const manifest = good();
    manifest.version = "0.1.0";
    manifest.notes = "";
    expect(verifyLatestJson(manifest, { tag, version })).toEqual([
      'version is "0.1.0", expected 0.2.0.',
      "notes are missing, so the update dialog would have nothing to show.",
    ]);
  });

  it("rejects something that is not an object", () => {
    expect(verifyLatestJson(null, { tag, version })).toEqual(["latest.json is not a JSON object."]);
  });
});

describe("parseVersion and isPrerelease", () => {
  it("reads releases and prereleases", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    expect(parseVersion("0.2.0-beta.1").prerelease).toBe("beta.1");
    expect(isPrerelease("v0.2.0-beta.1")).toBe(true);
    expect(isPrerelease("0.2.0")).toBe(false);
  });

  it.each(["1.2", "v1.2.3", "1.2.3.4", "", undefined])("rejects %j", (version) => {
    expect(() => parseVersion(version)).toThrow(/is not a version/);
  });
});

describe("compareVersions", () => {
  it.each([
    ["0.1.0", "0.1.1"],
    ["0.1.9", "0.2.0"],
    ["0.9.0", "1.0.0"],
    ["0.2.0-beta.1", "0.2.0"],
    ["0.2.0-beta.2", "0.2.0-beta.10"],
    ["0.2.0-alpha.1", "0.2.0-beta.1"],
    ["0.2.0-beta", "0.2.0-beta.1"],
  ])("%s < %s", (older, newer) => {
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("nextVersion", () => {
  it.each([
    ["0.1.0", "patch", "0.1.1"],
    ["0.1.3", "minor", "0.2.0"],
    ["0.4.2", "major", "1.0.0"],
    ["0.2.0-beta.1", "patch", "0.2.0"],
    ["0.1.0", "0.2.0-beta.1", "0.2.0-beta.1"],
  ])("%s + %s = %s", (current, kind, next) => {
    expect(nextVersion(current, kind)).toBe(next);
  });

  it("never reuses or goes back to an older version", () => {
    expect(() => nextVersion("0.2.0", "0.2.0")).toThrow(
      "0.2.0 is not newer than the current version 0.2.0.",
    );
    expect(() => nextVersion("0.2.0", "0.1.5")).toThrow(/not newer/);
    expect(() => nextVersion("0.2.0", "0.2.0-rc.1")).toThrow(/not newer/);
    expect(() => nextVersion("0.2.0", "huge")).toThrow(/is not a version/);
  });
});

describe("releaseChangelog", () => {
  const changelog =
    "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- Added: loops.\n\n## [0.1.0]\n\n- First.\n";

  it("turns the Unreleased notes into the version's section", () => {
    const next = releaseChangelog(changelog, "0.2.0");
    expect(next).toContain("## [Unreleased]\n\n## [0.2.0]\n\n- Added: loops.");
    expect(extractReleaseNotes(next, "0.2.0")).toBe("- Added: loops.");
  });

  it("refuses a version that already has a section, or a changelog without Unreleased", () => {
    expect(() => releaseChangelog(changelog, "0.1.0")).toThrow("already has a section for 0.1.0");
    expect(() => releaseChangelog("# Changelog\n", "0.2.0")).toThrow(/no ## \[Unreleased\]/);
  });
});

describe("checkVersionFiles and setVersion", () => {
  const files = {
    packageJson: '{\n  "name": "smart-beat",\n  "version": "0.1.0"\n}\n',
    cargoToml:
      '[package]\nname = "smart-beat"\nversion = "0.1.0"\n\n[dependencies]\nfoo = { version = "9" }\n',
    cargoLock:
      '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "smart-beat"\nversion = "0.1.0"\n',
    tauriConf:
      '{\n  "version": "../package.json",\n  "bundle": {\n    "windows": {\n      "wix": {\n        "version": "0.1.0"\n      }\n    }\n  }\n}\n',
  };

  it("accepts files that agree", () => {
    expect(checkVersionFiles(files)).toEqual([]);
  });

  it("names every file that drifted", () => {
    const drifted = { ...files, cargoToml: files.cargoToml.replace('"0.1.0"', '"0.0.9"') };
    drifted.cargoLock = files.cargoLock.replace(
      'smart-beat"\nversion = "0.1.0"',
      'smart-beat"\nversion = "0.0.8"',
    );
    expect(checkVersionFiles(drifted)).toEqual([
      "src-tauri/Cargo.toml: version is 0.0.9, package.json says 0.1.0.",
      "src-tauri/Cargo.lock: smart-beat is 0.0.8, package.json says 0.1.0.",
    ]);
  });

  it("needs the numeric MSI version that belongs to the app version", () => {
    const beta = { ...files, packageJson: files.packageJson.replace("0.1.0", "1.0.0-beta.1") };
    beta.cargoToml = files.cargoToml.replace('"0.1.0"', '"1.0.0-beta.1"');
    beta.cargoLock = files.cargoLock.replace(
      'smart-beat"\nversion = "0.1.0"',
      'smart-beat"\nversion = "1.0.0-beta.1"',
    );
    expect(checkVersionFiles(beta)).toEqual([
      "src-tauri/tauri.conf.json: bundle.windows.wix.version is 0.1.0, expected 1.0.0.2001 for 1.0.0-beta.1.",
    ]);
    expect(checkVersionFiles(setVersion(beta, "1.0.0-beta.1"))).toEqual([]);
  });

  it("sets only Smart Beat's own version", () => {
    const updated = setVersion(files, "0.2.0");
    expect(checkVersionFiles(updated)).toEqual([]);
    expect(JSON.parse(updated.packageJson).version).toBe("0.2.0");
    expect(updated.cargoToml).toContain('foo = { version = "9" }');
    expect(updated.cargoLock).toContain('name = "serde"\nversion = "1.0.0"');
    expect(JSON.parse(updated.tauriConf).bundle.windows.wix.version).toBe("0.2.0");
    expect(JSON.parse(updated.tauriConf).version).toBe("../package.json");
  });
});

describe("msiVersion", () => {
  it.each([
    ["0.2.0", "0.2.0"],
    ["1.0.0-alpha.3", "1.0.0.1003"],
    ["1.0.0-beta.1", "1.0.0.2001"],
    ["1.0.0-beta.12", "1.0.0.2012"],
    ["1.0.0-rc.2", "1.0.0.3002"],
    ["1.0.0-beta", "1.0.0.2000"],
  ])("%s -> %s", (version, msi) => {
    expect(msiVersion(version)).toBe(msi);
  });

  it("orders alpha < beta < rc within one version", () => {
    const revision = (version) => Number(msiVersion(version).split(".")[3]);
    expect(revision("1.0.0-alpha.9")).toBeLessThan(revision("1.0.0-beta.1"));
    expect(revision("1.0.0-beta.9")).toBeLessThan(revision("1.0.0-rc.1"));
  });

  it("refuses what Windows cannot hold", () => {
    expect(() => msiVersion("1.0.0-preview.1")).toThrow(/alpha.N, beta.N or rc.N/);
    expect(() => msiVersion("1.0.0-beta.1000")).toThrow(/too large/);
    expect(() => msiVersion("256.0.0")).toThrow(/too large/);
  });
});

describe("versionedAssetName", () => {
  it.each([
    ["SmartBeat_macos_universal.dmg", "SmartBeat-0.2.0-macOS-universal.dmg"],
    ["SmartBeat_windows_x64-setup.exe", "SmartBeat-0.2.0-Windows-x64-setup.exe"],
    ["SmartBeat_windows_x64.msi", "SmartBeat-0.2.0-Windows-x64.msi"],
    ["SmartBeat_linux_x86_64.AppImage", "SmartBeat-0.2.0-Linux-x86_64.AppImage"],
    ["SmartBeat_linux_amd64.deb", "SmartBeat-0.2.0-Linux-amd64.deb"],
    ["SmartBeat_linux_x86_64.rpm", "SmartBeat-0.2.0-Linux-x86_64.rpm"],
  ])("%s -> %s", (stable, versioned) => {
    expect(versionedAssetName(stable, "0.2.0")).toBe(versioned);
  });

  it.each([
    "latest.json",
    "SmartBeat_macos_universal.app.tar.gz",
    "SmartBeat_windows_x64-setup.exe.sig",
    "other.dmg",
  ])("leaves %s alone", (name) => {
    expect(versionedAssetName(name, "0.2.0")).toBeNull();
  });
});
