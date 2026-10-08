import { describe, expect, it } from "vitest";

import {
  assertTagMatchesVersion,
  extractReleaseNotes,
  RELEASE_URL_PREFIX,
  UPDATER_TARGETS,
  verifyLatestJson,
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
