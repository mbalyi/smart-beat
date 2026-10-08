# Releases and updates

Issue: [#82](https://github.com/mbalyi/smart-beat/issues/82)

GitHub Releases is the only place Smart Beat's installers are downloaded from. The same release feeds the website (links to the newest installers) and the in-app updater (`latest.json`). There is no download server of our own.

## How a release is made

1. Pick the version and put it in `package.json` (`"version"`). Tauri reads it from there.
2. In [`CHANGELOG.md`](../CHANGELOG.md), rename `## [Unreleased]` to `## [<version>]` and start a new empty `## [Unreleased]` above it. This text becomes the release notes and what the update dialog shows.
3. Merge to `main`, then tag and push. The tag must be `v` + the version:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. [`release.yml`](../.github/workflows/release.yml) builds every installer and the updater bundles, and uploads them to a **draft** release. It fails early if the tag does not match `package.json`, if `CHANGELOG.md` has no section for the version, or if the updater signing key is missing.
5. The last job (`Check the draft release`) lists the assets and checks `latest.json` with [`scripts/verify-latest-json.mjs`](../scripts/verify-latest-json.mjs): every target has a signature and a download URL inside this repository's release.
6. Open the draft on GitHub, look at the assets and the notes, and **publish** it. Publishing is what makes `releases/latest/...` point at it, so only then do the website and the updater see it.

To try the pipeline without a tag, run the workflow by hand (Actions › Release › Run workflow) with _Also create a draft GitHub Release_ ticked. It uses the version in `package.json` and does not publish anything.

## Updater signing key

The updater only installs updates signed with our key. This is separate from Apple and Windows code signing ([`code-signing.md`](code-signing.md)).

- **Created once** with `pnpm tauri signer generate -w ~/.tauri/smart-beat-updater.key`. It asks for a password.
- **The public key** (`~/.tauri/smart-beat-updater.key.pub`) is in [`tauri.conf.json`](../src-tauri/tauri.conf.json) under `plugins.updater.pubkey`. Installed apps trust exactly this key.
- **The private key and its password** are GitHub Actions secrets and nowhere else in the cloud:

  | Secret                               | Value                                     |
  | ------------------------------------ | ----------------------------------------- |
  | `TAURI_SIGNING_PRIVATE_KEY`          | The contents of `smart-beat-updater.key`  |
  | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen when creating the key |

- **Keep an encrypted offline backup** of the key file and the password (a password manager and an encrypted USB stick, for example). **If the key is lost, installed apps can never be updated again**: users would have to download a new installer by hand. Never commit the key.
- Pull requests, forks and local builds do not have the key. They build without updater bundles (`createUpdaterArtifacts` is only turned on by [`tauri.updater.conf.json`](../src-tauri/tauri.updater.conf.json), which the release workflow adds when the secret exists).

To test updater bundles locally, with a throwaway key (never the real one):

```bash
pnpm tauri signer generate --ci -p test -w /tmp/test-updater.key
TAURI_SIGNING_PRIVATE_KEY_PATH=/tmp/test-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test \
  pnpm tauri build --config src-tauri/tauri.updater.conf.json
```

The `.app.tar.gz` and `.sig` files appear next to the `.dmg` under `src-tauri/target/release/bundle/`.

## What a release contains

| Platform | Installer for people                                      | Used by the updater         |
| -------- | --------------------------------------------------------- | --------------------------- |
| macOS    | `.dmg` (universal: Apple Silicon and Intel)               | `.app.tar.gz` + `.sig`      |
| Windows  | NSIS `-setup.exe`, and `.msi`                             | The NSIS installer + `.sig` |
| Linux    | `.AppImage`, `.deb`, `.rpm`                               | `.AppImage` + `.sig`        |
| All      | `latest.json`: version, notes, URL + signature per target | Read by the app             |

Linux: only the AppImage updates itself. People who installed the `.deb` or `.rpm` update through a new download.

### Stable download links for the website

The workflow names assets without the version (`releaseAssetNamePattern` in `release.yml`: `SmartBeat_<platform>_<arch><setup><ext>`), so the website can always link to

```
https://github.com/mbalyi/smart-beat/releases/latest/download/<asset name>
```

and to <https://github.com/mbalyi/smart-beat/releases> for all versions. The website lives in its own repository and must not host binaries. **Check the exact asset names on the first draft release** (the last job prints them) and copy them into the website; they are stable from then on.

## How the app updates itself

- A few seconds after startup, if the last automatic check was more than a day ago, the app asks `latest.json` whether a newer version exists. Nothing is shown when there is none, or when the check fails (offline, no release yet).
- If there is one, a dialog shows the installed and the new version, the release notes, **Later** and **Download & Install**. Nothing is downloaded until the person clicks the button. The download shows progress, the update's signature is verified, it is installed, and the app restarts.
- **Help › Check for Updates…** does the same on request and always answers, including "You're up to date" and errors.
- The time of the last automatic check is remembered in the app's local storage (`smart-beat:last-update-check`).

While the repository is private, `latest.json` cannot be downloaded without a login, so the check fails quietly. Updates start working when the repository is public.

## Before the first public release

Not done by code, so on the list:

- [ ] Create the updater key and add the two secrets (above); back the key up.
- [ ] Apple Developer ID signing and notarization, and Windows code signing ([`code-signing.md`](code-signing.md)). Updates work without them, but installers show warnings.
- [ ] Lawyer review of `LICENSE` use, `COMMERCIAL-LICENSE.md` and `EULA.md` ([ADR 0002](adr/0002-source-available-noncommercial-license.md)).
- [ ] Scan the repository **and its git history** for secrets (for example `gitleaks detect`), then re-run `pnpm licenses:check`.
- [ ] Publish a first release (N), then a second one (N+1), and check on each OS: the app finds N+1, shows the notes, verifies, installs and restarts. Only an install from a published release can prove the whole path (signature, URLs, permissions).
- [ ] Create the website repository and deploy it with GitHub Pages.
- [ ] Make the repository public.
