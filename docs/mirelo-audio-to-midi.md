# Audio-to-MIDI transcription

Smart Beat uses hosted **Mirelo Audio-to-MIDI Pro** with Smart Beat's own
Mirelo API key and credits. Users need no Mirelo account. Smart Beat runs no
inference server, and it neither runs the original MuScriptor small/medium
models nor distributes their research weights.

## API key

The Rust core compiles the key in from the `MIRELO_AI_API_KEY` environment
variable (`option_env!` in `src-tauri/src/mirelo.rs`):

- **Release builds:** `.github/workflows/release.yml` passes the
  `MIRELO_AI_API_KEY` GitHub secret to the build step.
- **Local development:** put `MIRELO_AI_API_KEY=...` in the repository's `.env`
  (git ignores it), or export it in the shell. An exported variable wins.
  `src-tauri/build.rs` reads `.env`, and Cargo rebuilds when either changes. If
  you create `.env` after a build, run `touch src-tauri/build.rs` once.
- **No key:** the dialog says transcription is not available in this build.
  Users never enter a key.

Every request runs in Rust, so the webview never sees the key. The key is not
secret from users, though. Anyone with an installer can extract it from the
binary, or read the `Authorization` header through a proxy they trust. They can
then spend Smart Beat's credits outside the app until the key is rotated, and
rotating needs a new release. Keep a spending cap on the key in Mirelo Studio.
If abuse becomes a problem, move the key to a small proxy service that holds it
and limits use per install.

## Service contract and limits

The integration uses `POST /v3/assets` and its signed multipart POST ticket,
`GET /v2/audio-to-midi/v1.0/preflight`, and the
`/v2/audio-to-midi/v1.0/jobs` create/poll routes. Audio-to-MIDI remains on v2 even
though the current asset API is v3. Source names sent to storage are generic
`recording.ext`, rather than the local filename.

[Official API schema](https://api.mirelo.ai/v3/openapi.json), checked 2026-10-10:

- MP3, WAV, FLAC, OGG and AAC. M4A, AIFF and Opus are not advertised as supported.
- Maximum 100 MiB and 30 minutes. The upload ticket may impose a lower byte limit.
- Instruments must use the documented IDs. An omitted list enables automatic
  detection; a supplied list is exhaustive.
- Estimated credit cost is based on client duration. The final charge uses
  server-probed duration and can differ. The UI explains this before confirmation.
- Default maximum five Audio-to-MIDI jobs in flight per key; approved accounts
  may differ. Authentication, plan/credit, rate and concurrency errors are shown.
- Job creation does **not** support `Idempotency-Key`. Never retry it automatically.
- Jobs request `timing: quantized`, so notes land on the detected beat grid and
  import as readable notation. Mirelo falls back to performance timing when it
  finds no reliable grid.
- An unrecognised job `status` counts as still running. The API marks the list
  as open.

Before sending a create request, Rust atomically saves an attempt marker in the
app data directory. After acceptance it saves the provider job URL. Resume only
polls that URL and downloads that job's result. A stopped wait, network error,
restart or polling deadline never creates a second paid job. An uncertain create
response cannot be recovered automatically; the user must explicitly dismiss
the attempt. Dismissal is blocked while a create request is still in flight. The journal contains no credentials, audio
content or source filename. Import or an explicit new transcription clears it.

Stop waiting and Close stop local waiting. The chosen endpoint has no documented
remote cancellation route, so a job may continue and consume credits. API calls
have a 120-second timeout and the upload has 30 minutes; polling stops after
10–60 minutes according to the job estimate. Expired provider results cannot be
recovered indefinitely.

## Entry points

Import from Audio… opens the same dialog from three places: the welcome screen,
the native File menu, and the File menu beside Open while a song is open. It is
a menu item there because the header has no room for another button: at
1280 px, edit mode would wrap the header onto a second line.

## Preview and import

The dialog shows a piano roll, generated instruments, visibility/mute/solo
controls and synthesized-tone playback. This lightweight preview preserves note
timing and velocity, but is not a sampled instrument rendition. Imported MIDI
uses Smart Beat's existing score importer and normal instrument playback.

Import opens a new score immediately, preserves the recording name as the score
title, and keeps existing scores open. Failed import keeps the MIDI result in the
dialog. Save MIDI As writes the original bytes. No temporary MIDI file is needed.
After restart, the result uses a generic recovery name because source filenames
are not persisted in the job journal.

## Privacy and licensing

Audio travels directly from the native app to Mirelo's signed storage endpoint;
Smart Beat has no remote audio store or transcription analytics. The dialog's
privacy and terms links open fixed URLs in the system browser through a
native command, because the webview ignores `target="_blank"`.

Mirelo's [privacy policy](https://mirelo.ai/privacy), updated 2026-10-02, says API
uploads are deleted after 24 hours. API results are available for 24 hours and
non-SFX results are deleted within seven days. Training copies can remain until
account deletion. Paid users may opt out of future training in Studio; free users
cannot. Previously copied training content is not removed by opting out, and
subprocessors may have different retention periods. The dialog links the policy
and [service terms](https://mirelo.ai/terms) before upload. Recheck these statements
before release and whenever the provider changes its policy.

Instrument aliases and fuzzy matching are adapted from MuScriptor's
`web/src/instruments.ts`, commit `7f213afecf23bd6a1b8672aa223690ee9807cefb`.
The adaptation and the full MIT notice (`LICENSE`) live in
`src/lib/audio-transcription/upstream/`. The license generator adds the notice
to Help › Open-Source Licenses. Other upstream components target MuScriptor's
SSE inference and playback architecture; Smart Beat uses its own design system
and job/provider interface instead. No provider logos or research model weights are included.
Hosted inference follows Mirelo's service terms, rather than the original
weights' CC BY-NC license. Reassess service terms before adding a paid feature.

## Validation remaining before release

Automated tests cover file validation, instrument aliases/multi-select, paid
confirmation, preview/import/save, native error messages, recovery and duplicate
submission protection. Native tests validate payloads, journal persistence,
unmetered quotes, note parsing and credential-safe job URLs.
`e2e/audio-transcription.spec.ts` runs the whole flow in Chromium and WebKit
against mocked native commands: connect, upload, cost check, transcribe,
preview, and import through the real MIDI importer. It also scans the dialog
with axe at 375 px in light and dark mode and walks it by keyboard.

Live transcription with the production key still needs a manual smoke
test on macOS, Windows and Linux, including longer files, conditioned/automatic
instruments, quota exhaustion and network interruption. No account has been
registered, charged or assumed to have partner access by this implementation.
