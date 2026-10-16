# Code signing and notarization plan

Issue: [#2](https://github.com/mbalyi/smart-beat/issues/2)

Smart Beat will be given away to the public, so installers must open without scary warnings. This document covers:

- what happens with today's unsigned builds;
- what each platform needs;
- which GitHub secrets turn signing on in [`release.yml`](../.github/workflows/release.yml).

## Status today

| Platform | Current build                                             | What users see                                                                                                                                                                                                                              |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | **Ad-hoc signed** (`signingIdentity: "-"`), not notarized | Gatekeeper blocks the first launch: _"Apple could not verify 'Smart Beat' is free of malware"_. Users must open **System Settings → Privacy & Security → Open Anyway**. macOS 15 no longer allows bypassing this with Control-click → Open. |
| Windows  | Unsigned `.msi` and NSIS `.exe`                           | SmartScreen: _"Windows protected your PC"_. Users click **More info → Run anyway**.                                                                                                                                                         |
| Linux    | Unsigned `.AppImage`, `.deb`, `.rpm`                      | No warning. Package managers only verify signatures for repositories, not local files.                                                                                                                                                      |

This is fine for internal testing. **Set up signing before the first public release.**

## macOS: Developer ID + notarization (required for public release)

1. **Join the Apple Developer Program** (99 USD/year) as an individual or an organization. An organization account shows the company name in Gatekeeper dialogs.
2. **Create a Developer ID Application certificate** (Xcode → Settings → Accounts → Manage Certificates, or developer.apple.com). Export it with its private key as a `.p12`.
3. **Create an App Store Connect API key** (Users and Access → Integrations → Team Keys, role _Developer_) for notarization. Tauri also accepts Apple ID + app-specific password, but API keys don't expire with password changes and don't need 2FA.
4. **Add the GitHub secrets:**

   | Secret                       | Value                                                |
   | ---------------------------- | ---------------------------------------------------- |
   | `APPLE_CERTIFICATE`          | `base64 -i certificate.p12`                          |
   | `APPLE_CERTIFICATE_PASSWORD` | Password of the `.p12`                               |
   | `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Mark Balyi (TEAMID)` |
   | `APPLE_API_ISSUER`           | Issuer ID of the API key                             |
   | `APPLE_API_KEY`              | Key ID                                               |
   | `APPLE_API_KEY_P8`           | Contents of the downloaded `AuthKey_<KeyID>.p8`      |

5. **What happens in CI:** `release.yml` imports the certificate into a temporary keychain. Tauri signs the app with the hardened runtime, submits it to `notarytool`, and staples the notarization ticket to the `.app` and `.dmg`. If the secrets are missing, the workflow falls back to ad-hoc signing, which is today's behavior.
6. **Entitlements:** `src-tauri/Entitlements.plist` (set as `bundle.macOS.entitlements`) grants `com.apple.security.device.audio-input` for the tuner's microphone (#83), and `src-tauri/Info.plist` adds the `NSMicrophoneUsageDescription` macOS shows when it asks. Without both, macOS silently denies the microphone under the hardened runtime.

The plugin helper alone uses `PluginHelper.entitlements.plist`, which disables library validation so it can load third-party VST3 and CLAP binaries. The main app retains library validation. `stage-plugin-helper.mjs` signs the helper with the release identity or ad-hoc identity before bundling. With CI certificate secrets, it imports a separate temporary keychain and deletes it afterward.

Tauri CLI 2.12.1 applies the app entitlement file to every binary in its signing list, replacing pre-existing sidecar signatures. The macOS platform configuration therefore disables `externalBin` and copies the signed helper through `bundle.macOS.files`. Tauri copies these custom files after collecting signing targets, then signs the containing app. Destinations in this map are relative to `Contents`. Runtime discovery prefers this `smart-beat-plugin-helper` executable over Cargo's extra `vst3-host-helper` copy. Keep this ordering when upgrading Tauri, and verify the final bundle rather than only the staged executable. See upstream [bundle construction](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/macos/app.rs) and [global signing entitlements](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/macos/sign.rs).

To verify a build locally:

```bash
codesign --verify --deep --strict --verbose=2 "Smart Beat.app"
codesign -d --entitlements :- "Smart Beat.app"  # microphone only
codesign -d --entitlements :- "Smart Beat.app/Contents/MacOS/smart-beat-plugin-helper"  # helper exception
spctl --assess --type execute --verbose "Smart Beat.app"
xcrun stapler validate "Smart Beat.dmg"
```

## Windows: Authenticode

Since June 2023, code-signing keys must live on a hardware security module (HSM), so a `.pfx` file in a secret is no longer an option. There are two routes:

| Option                                                                      | Cost              | Notes                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Azure Artifact Signing** (formerly Trusted Signing), **recommended**      | ~10 USD/month     | Microsoft-managed HSM with short-lived certificates. Identity validation is required. Check whether individual developers in your country are eligible. Integrates through `bundle.windows.signCommand` and `trusted-signing-cli`. |
| OV certificate on a cloud HSM (SSL.com eSigner, DigiCert KeyLocker, Certum) | ~150–400 USD/year | Works for individuals everywhere. Signs through the vendor's CLI in `signCommand`.                                                                                                                                                 |

SmartScreen reputation builds up per certificate as downloads accumulate. EV certificates no longer skip that warm-up period (a change from 2024), so an EV certificate isn't worth the extra cost.

GitHub secrets for Azure Artifact Signing: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, plus the account endpoint and certificate profile name in `tauri.conf.json`. Once they're set, add a `signCommand` to `bundle.windows` and enable the signing step in `release.yml`.

## Linux

- **AppImage:** optionally GPG-sign it by setting `SIGN=1`, `SIGN_KEY` and `APPIMAGETOOL_SIGN_PASSPHRASE` in the release job. Few users verify these signatures, so this is low priority.
- **.deb/.rpm:** signatures matter once we publish an apt or dnf repository. Until then, users install the files directly.

## Auto-updates

The in-app updater (#82) verifies updates with its own Ed25519 key, independent of OS code signing. It is set up; the key, secrets and release steps are in [`release.md`](release.md). Without OS signing (above), the updater still works, but a freshly downloaded first install shows the warnings from the table at the top.

## Cost summary

| Item                           | Yearly cost  |
| ------------------------------ | ------------ |
| Apple Developer Program        | 99 USD       |
| Azure Artifact Signing (Basic) | ~120 USD     |
| **Total**                      | **~220 USD** |
