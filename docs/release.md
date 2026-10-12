# Releases and updates

Issues: [#82](https://github.com/mbalyi/smart-beat/issues/82), [#97](https://github.com/mbalyi/smart-beat/issues/97)

GitHub Releases is the only place Smart Beat's installers are downloaded from. The same release feeds the website (links to the newest installers) and the in-app updater (`latest.json`). There is no download server of our own.

## Versions

Smart Beat uses [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **Before 1.0:** a patch release (`0.1.1`) fixes bugs or makes small improvements; a minor release (`0.2.0`) adds features and may change behaviour. `1.0.0` is reserved for the first release with a stable file format and settings.
- **Prereleases** (`0.2.0-beta.1`, `0.2.0-rc.1`) are published as GitHub prereleases. `releases/latest` never points at a prerelease, so the updater and the website's download links never offer one.
- **One canonical version:** `package.json`. `tauri.conf.json` reads it from there (the About dialog, the bundle metadata, installer names and `latest.json` follow), and `src-tauri/Cargo.toml` and `Cargo.lock` must match it. `pnpm version:check` (part of `pnpm check`, and the release workflow with the tag) fails when they drift. A Rust test checks the same.
- **Never reuse a version:** the bump script refuses a version that is not newer, and a tag that already exists locally or on GitHub.

| Command                                                  | Does                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm release:patch` / `release:minor` / `release:major` | Bumps `package.json`, `Cargo.toml` and `Cargo.lock`, and turns `## [Unreleased]` in the changelog into `## [<version>]` |
| `node scripts/version.mjs 0.3.0-beta.1`                  | The same for an explicit (pre)release version                                                                           |
| `pnpm version:check`                                     | Checks that every file carries the same version                                                                         |

Release assets come in two names: a stable one without the version (`SmartBeat_macos_universal.dmg`, for the website's links) and a versioned copy (`SmartBeat-0.2.0-macOS-universal.dmg`, `SmartBeat-0.2.0-Windows-x64-setup.exe`, `SmartBeat-0.2.0-Linux-x86_64.AppImage`, …), added by the last job of the release workflow.

## How a release is made

1. On a clean branch from `main`, run `pnpm release:patch` (or `release:minor`, `release:major`). It sets the version everywhere and moves the `## [Unreleased]` notes in [`CHANGELOG.md`](../CHANGELOG.md) under `## [<version>]`. That text becomes the release notes and what the update dialog shows: read it and tidy it up.
2. Run `pnpm check`, `pnpm test:e2e` and `pnpm licenses:check`, and open a PR. CI also runs the secret scan.
3. Merge to `main`, then tag and push. The tag must be `v` + the version:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

4. [`release.yml`](../.github/workflows/release.yml) builds every installer and the updater bundles, and uploads them to a **draft** release. It fails early if the tag does not match `package.json` (or `Cargo.toml` disagrees), if `CHANGELOG.md` has no section for the version, or if the updater signing key is missing.
5. The last job (`Check the draft release`) lists the assets and checks `latest.json` with [`scripts/verify-latest-json.mjs`](../scripts/verify-latest-json.mjs): every target has a signature and a download URL inside this repository's release. Then it adds the versioned copies of the installers.
6. Open the draft on GitHub, look at the assets and the notes, and **publish** it. Publishing is what makes `releases/latest/...` point at it, so only then do the website and the updater see it.

To try the pipeline without a tag, run the workflow by hand (Actions › Release › Run workflow) with _Also create a draft GitHub Release_ ticked. It uses the version in `package.json` and does not publish anything.

## Usage counters

Release builds send anonymous usage counters to the Cloudflare Worker in [`analytics/`](../analytics) ([`analytics.md`](analytics.md)). The address comes from the repository **variable** `ANALYTICS_URL` (Settings › Secrets and variables › Actions › Variables), for example `https://smart-beat-analytics.<account>.workers.dev/v1/batch`; the workflow bakes it into the build together with the installer type. Without the variable, or in a pull request, the build has no address and never sends anything.

## Updater signing key

The updater only installs updates signed with our key. This is separate from Apple and Windows code signing ([`code-signing.md`](code-signing.md)).

- **Created once** with `pnpm tauri signer generate -w ~/.tauri/smart-beat-updater.key`. It asks for a password.
- **The public key** (`~/.tauri/smart-beat-updater.key.pub`, key id `5A8A7AAC23156B53`) is in [`tauri.conf.json`](../src-tauri/tauri.conf.json) under `plugins.updater.pubkey`. Installed apps trust exactly this key.
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
TAURI_SIGNING_PRIVATE_KEY=/tmp/test-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test \
  pnpm tauri build --config src-tauri/tauri.updater.conf.json
```

The build reads the key from `TAURI_SIGNING_PRIVATE_KEY`, which can be the key text or the path to the key file. The `.app.tar.gz` and its `.sig` appear under `src-tauri/target/release/bundle/macos/`.

## Transcription server

Import from Audio compiles in the address of Smart Beat's MuScriptor server ([`audio-to-midi.md`](audio-to-midi.md)). Add it as the `TRANSCRIPTION_SERVICE_URL` GitHub Actions variable (Settings › Secrets and variables › Actions › Variables), for example `https://transcribe.example.com`. It is not a secret. A build for a release fails without it. Other builds warn and ship without Import from Audio.

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

- [ ] Add the two updater secrets on GitHub (the key exists and its public half is in `tauri.conf.json`); back the key file and its password up offline.
- [ ] Deploy the MuScriptor server on AWS and add the `TRANSCRIPTION_SERVICE_URL` variable on GitHub ([`audio-to-midi.md`](audio-to-midi.md)).
- [ ] Clear the CC BY-NC 4.0 licence of the MuScriptor weights for Smart Beat's use ([`audio-to-midi.md`](audio-to-midi.md#licensing)).
- [ ] Apple Developer ID signing and notarization, and Windows code signing ([`code-signing.md`](code-signing.md)). Updates work without them, but installers show warnings.
- [ ] Before any paid offer: lawyer review of `LICENSE` use, `COMMERCIAL-LICENSE.md` and `EULA.md` ([licensing.md](licensing.md#legal-review)).
- [x] Scan the repository **and its git history** for secrets: done for #97 on 2026-10-12 (gitleaks, nothing found); CI repeats it on every PR. Re-run `pnpm licenses:check` right before going public.
- [ ] Make the project board public too (README and CONTRIBUTING link to it), and check that `smart-beat@outlook.com` receives mail.
- [ ] Publish a first release (N), then a second one (N+1), and check on each OS: the app finds N+1, shows the notes, verifies, installs and restarts. Only an install from a published release can prove the whole path (signature, URLs, permissions).
- [ ] Create the website repository and deploy it with GitHub Pages.
- [ ] Make the repository public.
