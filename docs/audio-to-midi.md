# Audio-to-MIDI transcription

Import from Audio sends a recording to Smart Beat's own transcription server. The server
runs [MuScriptor](https://github.com/muscriptor/muscriptor), the music transcription model
by Kyutai and Mirelo, with the
[medium weights](https://huggingface.co/MuScriptor/muscriptor-medium), on AWS. The app
needs no API key, no account and no credits.

## Server address

`src-tauri/build.rs` compiles the server address in from `TRANSCRIPTION_SERVICE_URL`. The
address must use `https://`. Only a server on this computer may use `http://`: the host must
be exactly `localhost`, `127.0.0.1` or `[::1]`. `src-tauri/src/service_url.rs` parses the
URL, so an address such as `http://localhost:80@example.com`, whose host is `example.com`,
fails the build. A user name, password, query or fragment also fails it.

- **Release builds:** `.github/workflows/release.yml` passes the `TRANSCRIPTION_SERVICE_URL`
  GitHub Actions variable. A tagged release fails without it ([`release.md`](release.md)).
- **Local development:** put `TRANSCRIPTION_SERVICE_URL=...` in the repository's `.env`
  (git ignores it; see `.env.example`), or export it in the shell. An exported variable
  wins. Cargo rebuilds when either changes. If you create `.env` after a build, run
  `touch src-tauri/build.rs` once.
- **No address:** the dialog says transcription is not available in this build.

To run the server on your own machine, log in to Hugging Face and accept the weights'
licence ([MuScriptor README](https://github.com/muscriptor/muscriptor#huggingface-login-required)),
then:

```bash
uvx muscriptor serve --model medium            # listens on http://127.0.0.1:8222
echo 'TRANSCRIPTION_SERVICE_URL=http://localhost:8222' >> .env
```

## Service contract

The app uses MuScriptor's own server API, checked at commit
`7f213afecf23bd6a1b8672aa223690ee9807cefb` (`muscriptor/server.py`). Every request runs in
Rust (`src-tauri/src/transcription.rs`), so the webview's CSP still allows no remote host.

- `POST /transcribe`, `multipart/form-data`:
  - `file`: the recording, always named `recording.<ext>`, so the server never sees the
    local file name.
  - `instruments`: one field per expected instrument. None means automatic detection.
  - `detect_tempo=best-effort`.
  - No `X-Client-Id` header and no other identifier. MuScriptor uses that header to let a
    client's new request stop its earlier run. The app's Cancel closes the connection
    instead.
- The response is `text/event-stream`. The app reads `progress` (`completed`, `total`),
  note `start` and `end`, and the final `transcription_complete` event. The app imports
  `quantized_midi`, the notes snapped to the detected beat grid, because notation needs
  them. Without a beat grid it imports `data`, the performance timing. The preview shifts
  the streamed notes back by `beat_grid.onset_delay` to match the file.
- A stream that ends without `transcription_complete` is a failure. The app says so and
  keeps the recording selected. The app also reads a last event that has no blank line
  after it.
- `400`: the server could not decode the audio, or an instrument name is unknown.
- `503`: this server instance is busy. MuScriptor runs one transcription per process. It
  reads the whole upload before it answers 503, so each retry uploads the recording again.
  The app asks again after 10, 20 and then every 40 seconds, for up to 3 minutes, so a load
  balancer can send the retry to an idle instance. A rate limit in front of the server
  answers `429`, and the app waits the same way.
- Cancel closes the connection. The server stops at the next chunk and frees the instance.
  Nothing is billed, so the app keeps no job journal: after a restart, transcribe again.

Formats: MP3, WAV, FLAC and OGG. The server decodes them with libsndfile, which cannot read
AAC or M4A. The app's limits are 100 MiB and 15 minutes; 15 minutes matches MuScriptor's
own limit for its blocking route. MuScriptor's streaming route has no length limit, so Rust
measures the length itself with symphonia before the upload. The webview's measurement only
shows the length early.

The page sends the recording to Rust as the request body. A file dropped on the window
reaches Rust as a path instead: Rust records the paths of each drop and reads only those,
once per drop, so the page cannot choose another file on disk to upload. The instrument ids in
`src/lib/audio-transcription/instrument-ids.json` are MuScriptor's 35 instrument groups,
the same list `GET /instruments` returns. Keep them in sync when the server is updated.

## AWS deployment requirements

The AWS side is not in this repository. The app depends on these properties:

- **Process:** `muscriptor serve --model medium --host 0.0.0.0`. The default host,
  `127.0.0.1`, is not reachable from a load balancer. The weights download from Hugging
  Face needs a token whose account accepted the licence. Bake the weights into the image or
  cache them, so a new instance does not download them on its first request.
- **Capacity:** one transcription per instance at a time, on a GPU. Run as many instances
  as the expected concurrent transcriptions.
- **Load balancer:** an Application Load Balancer with HTTPS works. API Gateway does not:
  its 10 MB request limit and 30-second timeout break uploads and the event stream.
- **Timeouts and buffering:** raise the load balancer's idle timeout to at least 300
  seconds, the app's read timeout. The upload, tempo detection and slow chunks can go
  quiet for over a minute. Any proxy in front of the server must allow 100 MiB request
  bodies and must not buffer the event stream. The server already sends
  `X-Accel-Buffering: no` for nginx.
- **Health check:** `GET /health`.
- **Privacy:** do not log request bodies and do not store uploads or results. The dialog
  tells users the server keeps neither the recording nor the MIDI.
- **Abuse:** the endpoint has no authentication by design. Put a rate limit in front of it,
  for example an AWS WAF rate-based rule, so nobody can use the GPUs for free at scale.

## Entry points

Import from Audio… opens the same dialog from three places: the welcome screen, the native
File menu, and the File menu beside Open while a song is open. It is a menu item there
because the header has no room for another button: at 1280 px, edit mode would wrap the
header onto a second line.

## Preview and import

The dialog shows a piano roll, the generated instruments, show/mute/solo controls and
synthesized-tone playback. This preview keeps note timing but is not a sampled instrument
rendition. Imported MIDI goes through Smart Beat's existing score importer and normal
instrument playback.

Import opens a new score immediately, uses the recording name as the score title, and keeps
existing scores open. A failed import keeps the MIDI in the dialog. Save MIDI As writes the
same bytes the import uses. No temporary MIDI file is needed.

## Privacy

The recording travels from the native app to Smart Beat's server over HTTPS. The server
processes it in memory. Smart Beat counts completed transcriptions in its anonymous usage
counters, without file names or transcription content. See [analytics](analytics.md).

## Licensing

- **Code:** instrument aliases and fuzzy matching are adapted from MuScriptor's
  `web/src/instruments.ts`, commit `7f213afecf23bd6a1b8672aa223690ee9807cefb`. The
  adaptation and the full MIT notice (`LICENSE`) live in
  `src/lib/audio-transcription/upstream/`. The license generator adds the notice to
  Help › Open-Source Licenses. The app ships no MuScriptor weights.
- **Weights:** the MuScriptor medium weights are licensed under
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), which allows only
  non-commercial use. `AGENTS.md` says not to add models with non-commercial licences, and
  Smart Beat offers commercial licences (`COMMERCIAL-LICENSE.md`). **Clear this before
  release:** get permission from Kyutai and Mirelo, or confirm in writing that Smart Beat's
  use is non-commercial. The dialog credits Kyutai and Mirelo, as the licence's attribution
  term requires.
- No provider logos are included.

## Validation remaining before release

Automated tests cover:

- **Rust:** the event stream parser, note pairing, choosing quantized MIDI, busy and
  rate-limit retries, error messages, generic file names, cancel, file validation, the
  length measurement, dropped-file reads, the server address check and the network-client
  guard.
- **Vitest:** the provider's headers, progress and cancel, plus the dialog's validation,
  instruments, progress, cancel, retry, preview, save and import.
- **e2e:** `e2e/audio-transcription.spec.ts` runs the whole flow in Chromium and WebKit
  against mocked native commands, including import through the real MIDI importer. It also
  scans the dialog with axe at 375 px in light and dark mode and walks it by keyboard.

Still needed: a manual run against the AWS server on macOS, Windows and Linux, covering a
long file, chosen and automatic instruments, a busy server, Cancel and a network drop.
Check that the webview on each platform reads the duration of all four formats.
