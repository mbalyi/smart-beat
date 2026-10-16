import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { signPluginHelper } from "./sign-plugin-helper.mjs";

const certificateHash = "1234567890ABCDEF1234567890ABCDEF12345678";
const existingKeychain = "/Users/runner/Library/Keychains/login keychain-db";

function signingCommands(implementation = () => {}) {
  return vi.fn((command, args) => {
    const result = implementation(command, args);
    if (result !== undefined) return result;
    if (command === "security" && args[0] === "list-keychains" && !args.includes("-s"))
      return `    "${existingKeychain}"\n`;
    if (command === "security" && args[0] === "find-identity")
      return `  1) ${certificateHash} "Developer ID Application: Certificate Owner"\n     1 valid identities found\n`;
  });
}

it("registers the imported keychain and signs with its certificate identity", () => {
  let registered = false;
  const run = signingCommands((command, args) => {
    if (command === "security" && args[0] === "list-keychains" && args.includes("-s"))
      registered = args.length > 5;
    if (command === "codesign" && args.includes("--sign")) {
      if (!registered || args[args.indexOf("--sign") + 1] !== certificateHash)
        throw new Error("no identity found");
    }
  });
  signPluginHelper("/tmp/helper", {
    env: {
      APPLE_SIGNING_IDENTITY: "A configured name that differs from the imported certificate",
      APPLE_CERTIFICATE: "dGVzdA==",
    },
    run,
  });
  expect(registered).toBe(false);
  expect(run.mock.calls.at(-2)[1]).toEqual([
    "list-keychains",
    "-d",
    "user",
    "-s",
    existingKeychain,
  ]);
});

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
  const run = signingCommands();
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
  const run = signingCommands((command, args) => {
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
  const run = signingCommands((command) => {
    if (command === "codesign") throw new Error("signature failed");
  });
  expect(() =>
    signPluginHelper("/tmp/helper", {
      env: { APPLE_SIGNING_IDENTITY: "Developer ID: Test", APPLE_CERTIFICATE: "dGVzdA==" },
      run,
    }),
  ).toThrow("signature failed");
  expect(run.mock.calls.at(-2)[1]).toEqual([
    "list-keychains",
    "-d",
    "user",
    "-s",
    existingKeychain,
  ]);
  expect(run.mock.calls.at(-1)[1][0]).toBe("delete-keychain");
});

it("rejects an imported certificate without a valid identity and restores the search list", () => {
  const run = signingCommands((command, args) => {
    if (command === "security" && args[0] === "find-identity") return "0 valid identities found\n";
  });
  expect(() =>
    signPluginHelper("/tmp/helper", {
      env: { APPLE_SIGNING_IDENTITY: "Configured", APPLE_CERTIFICATE: "dGVzdA==" },
      run,
    }),
  ).toThrow("no valid code-signing identity");
  expect(run.mock.calls.some(([command]) => command === "codesign")).toBe(false);
  expect(run.mock.calls.at(-2)[1]).toEqual([
    "list-keychains",
    "-d",
    "user",
    "-s",
    existingKeychain,
  ]);
  expect(run.mock.calls.at(-1)[1][0]).toBe("delete-keychain");
});
