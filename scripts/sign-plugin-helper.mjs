// Tauri applies bundle.macOS.entitlements to every binary it signs. The plugin
// helper is therefore copied through macOS.files after Tauri collects its sign
// targets, carrying its own signature. The containing app is signed afterward.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export function signPluginHelper(binary, { env = process.env, run = execFileSync } = {}) {
  const identity = env.APPLE_SIGNING_IDENTITY || "-";
  const entitlements = path.resolve(
    import.meta.dirname,
    "../src-tauri/PluginHelper.entitlements.plist",
  );
  const sign = (keychain, signingIdentity = identity) => {
    const args = [
      "--force",
      "--sign",
      signingIdentity,
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
    ];
    if (identity !== "-") args.push("--timestamp");
    if (keychain) args.push("--keychain", keychain);
    args.push(binary);
    run("codesign", args, { stdio: "inherit" });
    run("codesign", ["--verify", "--strict", binary], { stdio: "inherit" });
  };
  if (!env.APPLE_CERTIFICATE || identity === "-") {
    sign();
    return;
  }
  // Tauri imports its certificate later, during bundling. Import a separate,
  // short-lived keychain for this helper rather than relying on that future step.
  const directory = mkdtempSync(path.join(tmpdir(), "smart-beat-helper-sign-"));
  const keychain = path.join(homedir(), "Library", "Keychains", `${randomUUID()}.keychain-db`);
  const certificate = path.join(directory, "certificate.p12");
  const password = randomUUID();
  let created = false;
  let originalKeychains = [];
  let searchListChanged = false;
  const security = (args) => {
    try {
      return run("security", args, { stdio: "pipe", encoding: "utf8" });
    } catch {
      // execFileSync errors include their arguments, including passwords.
      throw new Error(`Plugin helper signing failed during security ${args[0]}`);
    }
  };
  try {
    writeFileSync(certificate, Buffer.from(env.APPLE_CERTIFICATE, "base64"), { mode: 0o600 });
    originalKeychains = security(["list-keychains", "-d", "user"])
      .split("\n")
      .map((line) => line.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    security(["create-keychain", "-p", password, keychain]);
    created = true;
    security(["unlock-keychain", "-p", password, keychain]);
    security([
      "import",
      certificate,
      "-k",
      keychain,
      "-P",
      env.APPLE_CERTIFICATE_PASSWORD || "",
      "-T",
      "/usr/bin/codesign",
    ]);
    security([
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    // Match Tauri's certificate import: codesign needs the keychain registered
    // in the user search list, even when --keychain is passed explicitly.
    searchListChanged = true;
    security(["list-keychains", "-d", "user", "-s", ...originalKeychains, keychain]);
    // Tauri uses the imported certificate when APPLE_CERTIFICATE is supplied.
    // Its identity can differ from APPLE_SIGNING_IDENTITY; select its hash
    // rather than asking codesign to resolve an unrelated configured name.
    const identities = security(["find-identity", "-v", "-p", "codesigning", keychain]);
    const importedIdentity = identities.match(/^\s*\d+\)\s+([a-f0-9]{40})\s/im)?.[1];
    if (!importedIdentity)
      throw new Error("The imported plugin signing certificate has no valid code-signing identity");
    sign(keychain, importedIdentity);
  } finally {
    try {
      if (searchListChanged) security(["list-keychains", "-d", "user", "-s", ...originalKeychains]);
    } finally {
      try {
        if (created) security(["delete-keychain", keychain]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}
