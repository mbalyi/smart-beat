import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { signPluginHelper } from "./sign-plugin-helper.mjs";

it("keeps the library validation exception out of the app entitlements", () => {
  const root = path.resolve(import.meta.dirname, "../src-tauri");
  const app = readFileSync(path.join(root, "Entitlements.plist"), "utf8");
  const helper = readFileSync(path.join(root, "PluginHelper.entitlements.plist"), "utf8");
  expect(app).not.toContain("disable-library-validation");
  expect(app).toContain("com.apple.security.device.audio-input");
  expect(helper).toContain("com.apple.security.cs.disable-library-validation");
  expect(helper).not.toContain("com.apple.security.device.audio-input");
});

it("copies the signed macOS helper outside Tauri's global sidecar signing", () => {
  const config = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../src-tauri/tauri.macos.conf.json")),
  );
  expect(config.bundle.externalBin).toEqual([]);
  expect(config.bundle.macOS.files).toEqual({
    "MacOS/smart-beat-plugin-helper": "binaries/smart-beat-plugin-helper-macos",
  });
});

it("ad-hoc signs and verifies the helper with its own hardened entitlements", () => {
  const run = vi.fn();
  signPluginHelper("/tmp/helper", { env: {}, run });
  expect(run.mock.calls[0][0]).toBe("codesign");
  expect(run.mock.calls[0][1]).toEqual([
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    path.resolve(import.meta.dirname, "../src-tauri/PluginHelper.entitlements.plist"),
    "/tmp/helper",
  ]);
  expect(run.mock.calls[1][1]).toEqual(["--verify", "--strict", "/tmp/helper"]);
});

it("imports CI credentials into a temporary keychain and deletes it after signing", () => {
  const run = vi.fn();
  signPluginHelper("/tmp/helper", {
    env: {
      APPLE_SIGNING_IDENTITY: "Developer ID: Test",
      APPLE_CERTIFICATE: "dGVzdA==",
      APPLE_CERTIFICATE_PASSWORD: "secret",
    },
    run,
  });
  const sign = run.mock.calls.find(([command]) => command === "codesign");
  expect(sign[1]).toContain("--timestamp");
  expect(sign[1]).toContain("--keychain");
  const keychain = sign[1][sign[1].indexOf("--keychain") + 1];
  expect(run.mock.calls.at(-1).slice(0, 2)).toEqual(["security", ["delete-keychain", keychain]]);
});

it("cleans the keychain and redacts credential arguments when import fails", () => {
  const run = vi.fn((command, args) => {
    if (command === "security" && args[0] === "import")
      throw new Error("command failed -P supersecret");
  });
  expect(() =>
    signPluginHelper("/tmp/helper", {
      env: {
        APPLE_SIGNING_IDENTITY: "Developer ID: Test",
        APPLE_CERTIFICATE: "dGVzdA==",
        APPLE_CERTIFICATE_PASSWORD: "supersecret",
      },
      run,
    }),
  ).toThrow("Plugin helper signing failed during security import");
  expect(run.mock.calls.at(-1)[1][0]).toBe("delete-keychain");
});

it("cleans the keychain if codesign fails", () => {
  const run = vi.fn((command) => {
    if (command === "codesign") throw new Error("signature failed");
  });
  expect(() =>
    signPluginHelper("/tmp/helper", {
      env: { APPLE_SIGNING_IDENTITY: "Developer ID: Test", APPLE_CERTIFICATE: "dGVzdA==" },
      run,
    }),
  ).toThrow("signature failed");
  expect(run.mock.calls.at(-1)[1][0]).toBe("delete-keychain");
});
