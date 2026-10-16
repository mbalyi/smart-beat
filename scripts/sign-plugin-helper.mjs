// Tauri applies bundle.macOS.entitlements to every binary it signs. The plugin
// helper is therefore copied through macOS.files after Tauri collects its sign
// targets, carrying its own signature. The containing app is signed afterward.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function signPluginHelper(binary, { env = process.env, run = execFileSync } = {}) {
  const identity = env.APPLE_SIGNING_IDENTITY || "-";
  const entitlements = path.resolve(
    import.meta.dirname,
    "../src-tauri/PluginHelper.entitlements.plist",
  );
  const sign = (keychain) => {
    const args = [
      "--force",
      "--sign",
      identity,
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
  const keychain = path.join(directory, "helper.keychain-db");
  const certificate = path.join(directory, "certificate.p12");
  const password = randomUUID();
  let created = false;
  try {
    writeFileSync(certificate, Buffer.from(env.APPLE_CERTIFICATE, "base64"), { mode: 0o600 });
    const security = (args) => {
      try {
        run("security", args, { stdio: "pipe" });
      } catch {
        // execFileSync errors include their arguments, including passwords.
        throw new Error(`Plugin helper signing failed during security ${args[0]}`);
      }
    };
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
    sign(keychain);
  } finally {
    try {
      if (created) run("security", ["delete-keychain", keychain], { stdio: "pipe" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
