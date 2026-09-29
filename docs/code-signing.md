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
6. **Entitlements:** none are needed yet. When microphone input arrives (issue #20), add `com.apple.security.device.audio-input` through `bundle.macOS.entitlements` and an `NSMicrophoneUsageDescription` to `Info.plist`, otherwise macOS silently denies the microphone.

To verify a build locally:

```bash
codesign --verify --deep --strict --verbose=2 "Smart Beat.app"
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

## Auto-updates (later)

`tauri-plugin-updater` verifies updates with its own Ed25519 key, independent of OS code signing. When updates are added:

1. Run `pnpm tauri signer generate` and store the private key as `TAURI_SIGNING_PRIVATE_KEY` and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
2. Put the public key in `tauri.conf.json` under `plugins.updater.pubkey`.
3. Back up the private key offline. **If it is lost, installed apps can never be updated again.**

## Cost summary

| Item                           | Yearly cost  |
| ------------------------------ | ------------ |
| Apple Developer Program        | 99 USD       |
| Azure Artifact Signing (Basic) | ~120 USD     |
| **Total**                      | **~220 USD** |
