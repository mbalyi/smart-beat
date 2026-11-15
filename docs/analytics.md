# Anonymous usage counters

Issue: [#99](https://github.com/mbalyi/smart-beat/issues/99)

Smart Beat counts how often its features are used, so we can see which ones matter and which installers people use. It is built so that it **cannot** tell users apart: there is no identifier of any kind.

## What is sent

One request, `POST /v1/batch`, with this JSON and nothing else:

```json
{
  "version": "0.2.0",
  "os": "macos",
  "installer": "dmg",
  "counts": [
    { "day": "2026-10-10", "event": "loop_on", "count": 3 },
    { "day": "2026-10-10", "event": "export", "format": "pdf", "count": 1 },
    { "day": "2026-10-10", "event": "error", "format": "audio:audio", "count": 2 }
  ],
  "traces": [
    {
      "day": "2026-10-10",
      "format": "audio:audio",
      "hash": "eb78dee19e5ea0e2",
      "frames": ["audio_start", "src/audio/mod.rs:123", "src/lib/tauri.ts:650:12"],
      "ext": "mp3",
      "count": 2
    }
  ]
}
```

- `os`: `macos`, `windows` or `linux`.
- `installer`: `dmg`, `windows`, `appimage` or `linux-pkg`. The build knows its OS family; on Linux the app tells an AppImage (the `APPIMAGE` variable) from a system package. `.msi` and `.exe`, or `.deb` and `.rpm`, cannot be told apart (one build per OS), so use the download counts of the GitHub release assets for that split:

  ```bash
  gh api repos/mbalyi/smart-beat/releases --jq '.[].assets[] | {name, download_count}'
  ```

- `format`: a fixed detail allowed for that event. For `open_file`, `export`, `save` and `save_as`, a known extension (`gp3`, `gp4`, `gp5`, `gpx`, `gp`, `mid`, `midi`, `pdf`, `wav`, `m4a`, `mp3`, `musicxml`, `ogg`, `flac`, `txt`, `png`).
- `traces` (optional, only next to `error` counters, at most 100 per request): the anonymised error traces described in [Error traces](#error-traces-242). Old apps do not send it.
- Never sent: song or file names, titles, sound names, tempo or note values, volumes, anything typed, an error message, a path on your computer, an IP address (the server does not store it), a user or install id. The only code information that leaves your computer is in an error trace: the name of the failed command and locations inside Smart Beat's own code (anonymised frames, below).

## Counted features

`app_start`, `play`, `pause`, `stop`, `loop_on`, `speed_trainer_start`, `metronome_on`, `count_in_on`, `practice_mix` (focusing a track), `sound_change` (instrument sounds, presets, sound set), `open_file`, `export`, `save`, `save_as`, `mixer_open`, `effect_pedal` (changing a track's or the master effect chain), `sound_library_import`, `edit` (once per edit), `undo`, `redo`, `new_song`, `track_add`, `track_delete`, `solo_track`, `mute_track`, `tempo_change`, `transpose`, `copy_paste`, `chord_insert`, `notation_mode_switch`, `tuner`, `fretboard_view` / `piano_view` (the instrument view on a stringed track / on any other), `update_check`, `update_installed`, `theme_dark`, `theme_light`, `shift_select` (extending a score selection with Shift), `copy`, `cut`, `delete_selection`, `loop_selection`, `practise_selection`, `play_selection` (the score menu's selection actions), `restart_on_stop_on` / `restart_on_stop_off` (the "Auto-restart" practice option) and `restart_on_stop_used` (Stop sent the next Play back to the loop start) and `record_to_tab` (a finished Record to Tab take). Added in 1.0.1 (details below): `soundfont_select`, `play_soundfont`, `soundfont_download`, `soundfont_import`, `record_to_tab_start`, `record_to_tab_file`, `drum_normalize`, `track_duplicate`, `practice_speed`, `practice_range`, `speed_trainer_stop`, `speed_trainer_hold`, `practice_view`, `tour_start`, `tour_finish`, `tour_skip` and `tour_close`. Added in 1.1.0: `continuous_view` (switching the score to the continuous layout) and `multi_track_view` (stacking two or more tracks in it). Added in 1.1.0 (details below): `ai_install`, `ai_rights_confirmed`, `ai_transcribe_start` and `ai_transcribe_file`. Failures (#164, details below): `error` (a command failed) and `panic` (the Rust core panicked).

The list is one Rust enum (`Event` in [`src-tauri/src/telemetry.rs`](../src-tauri/src/telemetry.rs)) mirrored by the UI (`TrackedEvent`, [`src/lib/telemetry.ts`](../src/lib/telemetry.ts)) and the Worker ([`analytics/src/events.ts`](../analytics/src/events.ts)); anything else is refused at each end. To count a new feature, add it in all three places and call `track("name")` where the user does it.

New feature counters and their allowed details:

| Event                                                                                                                                  | Allowed detail in `format`                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pedal_add`, `pedal_remove`                                                                                                            | `gate`, `compressor`, `eq`, `drive`, `amp_sim`, `chorus`, `phaser`, `tremolo`, `delay`, `reverb`, `limiter`, `amp`, `cab`, `plugin`                     |
| `pedal_move`                                                                                                                           | None                                                                                                                                                    |
| `plugins_on`, `plugin_scan`                                                                                                            | None                                                                                                                                                    |
| `plugin_add`, `plugin_editor_open`                                                                                                     | `vst3`, `clap`                                                                                                                                          |
| `copy_to_instrument`                                                                                                                   | `guitar`, `electric-guitar`, `classical-guitar`, `guitar-7`, `guitar-8`, `guitar-9`, `bass-4`, `bass-5`, `bass-6`, `banjo`, `ukulele`, `piano`, `other` |
| `audio_transcribe`                                                                                                                     | None                                                                                                                                                    |
| `settings_open`                                                                                                                        | None                                                                                                                                                    |
| `audio_input_change`                                                                                                                   | None                                                                                                                                                    |
| `piano_model_download`                                                                                                                 | None                                                                                                                                                    |
| `record_to_tab`                                                                                                                        | `guitar`, `bass`, `piano`, `drums`                                                                                                                      |
| `sound_library_import`                                                                                                                 | `amp`, `cab`                                                                                                                                            |
| `soundfont_select`, `play_soundfont`                                                                                                   | `sonivox`, `fluidr3`, `musescore-general`, `generaluser-gs`, `fluidr3-gm`, `timbres-of-heaven`, `arachno`, `custom`                                     |
| `soundfont_download`                                                                                                                   | `musescore-general`, `generaluser-gs`, `fluidr3-gm`, `timbres-of-heaven`, `arachno`                                                                     |
| `soundfont_import`                                                                                                                     | None                                                                                                                                                    |
| `record_to_tab_start`, `record_to_tab_file`                                                                                            | `guitar`, `bass`, `piano`, `drums`                                                                                                                      |
| `ai_install`                                                                                                                           | `small`, `medium`, `large`                                                                                                                              |
| `ai_transcribe_start`, `ai_transcribe_file`                                                                                            | `rights_confirmed`, `rights_unconfirmed`                                                                                                                |
| `ai_rights_confirmed`                                                                                                                  | None                                                                                                                                                    |
| `drum_normalize`, `track_duplicate`                                                                                                    | None                                                                                                                                                    |
| `practice_speed`, `practice_range`, `speed_trainer_stop`, `speed_trainer_hold`, `practice_view`, `continuous_view`, `multi_track_view` | None                                                                                                                                                    |
| `tour_start`, `tour_finish`, `tour_skip`, `tour_close`                                                                                 | `main`, `editing`, `speed-trainer`, `effects`, `record-to-tab`                                                                                          |
| `error`                                                                                                                                | `<area>:<kind>` from the lists below, for example `audio:io`, `cloud:auth-expired`                                                                      |
| `panic`                                                                                                                                | the area only: `file`, `export`, `audio`, `plugin`, `import`, `ai`, `stems`, `cloud`, `practice`, `settings`, `other`                                   |
| `practice_together_open`                                                                                                               | `menu`, `toolbar`, `start`                                                                                                                              |
| `practice_together_host`, `practice_together_join`, `practice_together_setup_failed`, `practice_together_rejoin`                       | `lan`, `internet`                                                                                                                                       |
| `practice_together_remove`                                                                                                             | `kick`, `ban`                                                                                                                                           |
| `practice_together_sync`                                                                                                               | `excellent`, `good`, `unstable`                                                                                                                         |
| `practice_together_preset`                                                                                                             | `auto`, `tight`, `balanced`, `safe`                                                                                                                     |
| `practice_together_play`                                                                                                               | None                                                                                                                                                    |
| `practice_together_problem`                                                                                                            | `score`, `version`, `declined`, `busy`, `dropped`, `poor`, `late`, `woke`, `tab`                                                                        |
| `practice_together_tab`                                                                                                                | `sent`, `received`, `failed`                                                                                                                            |
| `practice_together_end`                                                                                                                | `left`, `peer_left`, `dropped`, `failed`, `removed`                                                                                                     |
| `practice_together_length`                                                                                                             | `under_1m`, `1_5m`, `5_15m`, `15_60m`, `over_60m`                                                                                                       |

Details are optional so older app batches still work. `save` and `save_as` also keep accepting file extensions sent by existing clients. Other events accept no detail. The wire field and database column keep the name `format`; no database migration is needed. Plugin names, paths, amp model or IR ids and device labels are never counted.

Pedal add, remove and reorder counters cover buttons, keyboard shortcuts and drag and drop. `effect_pedal` counts loading a pedalboard preset, once per action, and never knob moves. `plugin_editor_open` counts a successful editor open. `plugins_on` counts the user's opt-in action, not restoring the saved preference. `audio_transcribe` counts a completed Import from Audio transcription, even if the result is not imported. `settings_open` counts an explicit user open, not the automatic usage notice. `audio_input_change` counts choosing a different input, and `piano_model_download` counts starting a download, including retries.

Sound sets (1.0.1): `soundfont_select` counts picking one in Instrument sounds, and `play_soundfont` counts every time playback starts, also after a pause, so we learn what people listen with and not only what they picked. A SoundFont the user imported is counted as `custom`, never by its name or file; `soundfont_download` and `soundfont_import` count adding one. `record_to_tab_start` counts a live take that has begun and `record_to_tab_file` an audio file turned into tab, each per instrument, apart from `record_to_tab` (a finished take). `drum_normalize` counts Normalize drum notation, `track_duplicate` the Duplicate track action (copying a track to another instrument is `copy_to_instrument`). Practice: `practice_speed` and `practice_range` count a speed or bar-range change (including dragging bars in the score), `speed_trainer_stop` and `speed_trainer_hold` stopping or holding the Speed Trainer, `practice_view` entering Practice View; switching a tool off is not counted. Tours: `tour_start` counts a guided tour that begins (also when a part-way tour is continued), `tour_finish` one finished on its last step or by picking the next tour, `tour_skip` one skipped (or "Skip for now" on the start page, for `main`), and `tour_close` one closed part-way; the detail is the tour id, sub-tours separately. MuScriptor (1.1.0): `ai_install` counts a finished model download (the size is the detail), `ai_rights_confirmed` the moment a user ticks that they only use music they have the rights to, and `ai_transcribe_start` (a live take) and `ai_transcribe_file` (an audio file, in Record to tab or Import from Audio) count every start of an AI transcription. Their detail says whether that confirmation is on file (`rights_confirmed`); the app refuses to run the AI engine without it, so `rights_unconfirmed` should stay at zero and is counted only to prove that. No file, name, path or audio is ever part of a counter.

### Errors and panics (#164)

Counters show what fails, never why in words. Both events carry only fixed categories from lists in the code; anything else is refused at all three ends. Since #242 an `error` can also carry an anonymised trace saying _where in Smart Beat's code_ it failed (see [Error traces](#error-traces-242)); a `panic` is still only a counter.

- **Areas** (`ERROR_AREAS`): `file`, `export`, `audio`, `plugin`, `import` (Import from Audio), `ai` (MuScriptor, Record to tab, piano model), `stems`, `cloud`, `practice`, `settings`, `other`.
- **Kinds** (`ERROR_KINDS`): every `ErrorKind` of the Rust core in its wire spelling (`not-found`, `unsupported-type`, `too-large`, `not-a-score`, `invalid-key`, `invalid-settings`, `invalid-menu-state`, `audio`, `conflict`, `download-timeout`, `network`, `auth-expired`, `invalid-code`, `io`) and `unknown` for a failure without a kind.
- **`error`** counts a command that returned an error to the page. One wrapper (`invoke` in [`src/lib/invoke.ts`](../src/lib/invoke.ts)) counts every Tauri command, so plugin and audio-engine failures are included. The detail is `<area>:<kind>`: the area comes from the command's name ([`src/lib/error-counters.ts`](../src/lib/error-counters.ts)), the kind from the error's `kind`. The message and the arguments are never read or sent; the command name is sent only as the first frame of the optional trace. The error the user sees is unchanged. Failures a user causes (picking a file that is not a score, cancelling a separation) are counted like any other; they only add noise.
- **`panic`** counts a panic on any thread of the Rust core. A panic hook (`install_panic_hook` in [`telemetry.rs`](../src-tauri/src/telemetry.rs)) derives the area from the source file of the panic location (`audio/plugin*` is `plugin`, `audio/` is `audio`, `stems/` is `stems`, and so on; code of dependencies is `other`) and then **drops** the message and the location. The previous hook still runs, so the report on stderr is as before. The hook cannot panic (it runs under `catch_unwind`, because a panic inside a panic hook aborts the process) and cannot block: it adds to a lock-free counter, then writes `usage.json` only if its lock is free right then, and never touches the network on the panicking thread. Counts it could not write are written by the next normal access.
- **When they are sent.** Both are sent right away when the device is online, without waiting for the hourly pause, together with whatever else is queued. Offline, they stay in `usage.json` and go out with the next successful upload: the next tracked action after the 60 s back-off, the final upload when the app quits, or the upload at the next start. At most one such upload every 10 s, so a burst of errors is one request; the rest waits in the queue. A panic that ends the process (on the main thread, for example) may stop its own upload; its counter is already on disk and is sent at the next start.
- **Not counted.** The usage commands themselves (`track_event`, `get_usage_settings`, `set_usage_settings`), failures on the real-time audio thread that never return from a command, and anything while the counters are off.

### Error traces (#242)

The counters say that something fails, not where. For an `error` the app can add a **trace**: a few anonymised frames that point at the code, so a failure that happens often can be found and fixed. The scrubbing happens in the app, before anything is stored or sent, and the Worker checks the result again; the server never sees a raw stack trace.

- **What a trace is.** Up to 8 frames, in this order: the name of the failed command (such as `audio_start`), the place in Smart Beat's Rust code where the error was created (such as `src/audio/mod.rs:123`), then up to 5 call sites in the page's code (such as `src/lib/tauri.ts:650:12` or `startPlayback index-AbC123.js:1:48211`). Only the app's own code appears: `src/...` and `src-tauri/src/...` paths relative to the project, bundle file names without a folder, function names, and line and column numbers.
- **Frame rules.** A frame is at most 100 characters and is either a function-like name, a location, or a name and a location separated by one space. A frame with `@`, `\`, `..`, `://`, `?`, `#`, a number that looks like an IPv4 address, or 24 or more letters and digits in a row is invalid, and so is anything else outside that grammar. The app **drops** an invalid frame, and if no frame is left there is no trace; the error is still counted as before.
- **File type (`ext`).** For a failure on a file, the extension of that file, only from the same known list as `open_file` (`gp3` ... `png`), otherwise `other`. Never the file name or its folder.
- **Hash.** The first 16 hex characters of the SHA-256 of the top 2 frames, the command name and the Rust origin (joined by a line break); the page's call sites are left out because they change with every release. It is the group key: the same failure from many computers has the same hash. The app computes it and the Worker computes it again; a trace whose hash does not match is dropped.
- **Never part of a trace.** The error message or panic text, arguments, file or song names, folders such as your home folder or user name, URLs, query strings or tokens, host names, IP addresses, machine or install ids. The text of the error is never read; the call sites come from a stack taken where the failure is handled.
- **Off switch.** Traces follow the same switch as the counters: with _Share anonymous usage counts_ off nothing is stored or sent, and switching it off deletes traces that are not sent yet. They are sent in the same request as the counters and removed from the device when the server acknowledges it.
- **The Worker.** A trace with a wrong shape, a bad hash, a frame that breaks the rules, a trace for anything but an `error` (its `format` must be one of the `<area>:<kind>` details), a day out of range or more than 100 traces in one request is **dropped**; the request is not refused and its counters are stored. Per day at most 200 different hashes are kept; later new ones are dropped, a hash already stored still counts up. Frames are stored once per hash (`trace_frames`), the counts per `(day, hash, format, ext, version, os, installer)` (`error_traces`), and traces older than six months are deleted by the daily job together with frames nothing points to any more.

Practice together (1.2.0, details in the table above) is counted with fixed words only, so a session can be described without describing the people in it:

- `practice_together_open`: the dialog was opened, from `menu`, `toolbar` or `start` (the start screen button).
- `practice_together_host` / `practice_together_join`: a session was hosted or joined, `lan` (same network) or `internet`. `practice_together_setup_failed` counts a host or join that could not be set up, with the same two words.
- `practice_together_rejoin`: a guest came back to a session it was in (after a drop or a restart), `lan` or `internet`. `practice_together_remove`: the host removed a player, `kick` (it may come back) or `ban`. Who was removed is never part of it.
- `practice_together_sync`: the first time a session had a synchronized clock, with the quality word shown in the dialog (`excellent` up to ±5 ms, `good` up to ±15 ms, `unstable`). Once per session.
- `practice_together_preset`: the audio quality chosen (`auto`, `tight`, `balanced`, `safe`).
- `practice_together_play`: a shared start ran on this computer (no detail). It is counted next to `play`, so it says how much of the playback is shared.
- `practice_together_problem`: the session told its players about a problem, once when it appears: `score`, `version`, `declined`, `busy`, `dropped`, `poor`, `late`, `woke` or `tab`.
- `practice_together_tab`: the host's tab was whole on the other side (`sent` on the host, `received` on the guest) or could not be shared (`failed`).
- `practice_together_end`: how a session ended: `left` (this player), `peer_left`, `dropped` (the connection was lost for good), `removed` (the host removed this player) or `failed`. `practice_together_length` adds how long it had been synchronized, as `under_1m`, `1_5m`, `5_15m`, `15_60m` or `over_60m`. Never an exact time.

Never counted: room codes, tokens, IP addresses, player names, song or file names, the tab or any note in it, positions, tempos and the session id. A session has no identifier, so the counts say how often something happens, not who played with whom. The counters follow the same off switch as all the others. The same list is in the app (`src/lib/practice-together/analytics.ts` observes a session and counts each event at most once), the Rust core and the Worker. See [`practice-together.md`](practice-together.md).

## How it works

- **In the app.** `track()` asks the Rust core to add 1 to a per-day counter in `usage.json` (app data folder). No event log, no timestamps. The core uploads all counters in one batch on a background thread (5 s timeout). At launch it uploads straight from Rust and ignores the hourly pause. After that, uploads run in the background at most hourly, counted from the last _successful_ upload. Only what the server acknowledged with a 2xx is removed, so offline use is simply sent later. A failed upload starts only a 60 s back-off (`RETRY_AFTER`), so the next tracked action retries. A final batch is sent when the app quits or the last window closes; it ignores the pauses and has one 5 s budget in total, including the wait for an upload that is still running; unsent counters wait for the next launch. A failure writes one debug line to stderr with the HTTP status or error kind only, never counters or the address. Error traces (#242) wait in `usage.json` next to the counters and travel in the same batch. At most 30 days are kept locally. The upload runs in Rust (`ureq`); the page never makes a network request, so the content security policy stays closed.
- **Off switch.** Help › Settings › _Share anonymous usage counts_. Switching it off also deletes unsent counters and error traces. On a first run of a build that can send, a one-time notice says so.
- **When nothing is sent.** Development builds and pull-request builds have no address (`SMART_BEAT_ANALYTICS_URL` is set only by the release workflow), the setting is off, or the user is in a browser.
- **The server.** A Cloudflare Worker with a D1 database ([`analytics/`](../analytics)). It validates every field against the whitelists, adds the counts to one row per `(day, event, format, version, os, installer)` and stores nothing else: no IP address, user agent or request time. Error traces (#242) go into two more tables ([Error traces](#error-traces-242)). Cloudflare itself sees the connection (IP address) while it is made, as any web host does. Counters and error traces older than six months are deleted by a daily scheduled job.

## Reading the numbers

`GET /v1/summary?days=30` with the header `Authorization: Bearer <ANALYTICS_SUMMARY_TOKEN>` returns totals per event, per `event format`, per installer, per OS and per version, and `top_errors`: the 20 error groups with the most errors in the window (`format`, `hash`, `frames`, `ext`, `count`):

```bash
curl -s -H "Authorization: Bearer $ANALYTICS_SUMMARY_TOKEN" \
  "https://smart-beat-analytics.<account>.workers.dev/v1/summary?days=30" | jq
```

For anything else, query D1 directly, for example the most used features of the last week:

```bash
cd analytics
pnpm exec wrangler d1 execute smart-beat-analytics --remote --command \
  "SELECT event, SUM(count) AS uses FROM daily_counts WHERE day >= date('now','-7 day') GROUP BY event ORDER BY uses DESC"
```

The most frequent error groups of the last week, with their frames:

```sql
SELECT t.format, t.hash, t.ext, SUM(t.count) AS errors, f.frames
FROM error_traces t LEFT JOIN trace_frames f ON f.hash = t.hash
WHERE t.day >= date('now','-7 day')
GROUP BY t.format, t.hash, t.ext
ORDER BY errors DESC LIMIT 20
```

The same groups without the file type, with the first two frames spelled out, and the share of errors that carried a trace:

```sql
SELECT t.format, t.hash, SUM(t.count) AS errors,
       json_extract(f.frames, '$[0]') AS command, json_extract(f.frames, '$[1]') AS origin
FROM error_traces t LEFT JOIN trace_frames f ON f.hash = t.hash
WHERE t.day >= date('now','-7 day')
GROUP BY t.format, t.hash
ORDER BY errors DESC LIMIT 20;

SELECT (SELECT SUM(count) FROM daily_counts WHERE event = 'error' AND day >= date('now','-7 day')) AS errors,
       (SELECT SUM(count) FROM error_traces WHERE day >= date('now','-7 day')) AS with_trace;
```

Which versions a group comes from (replace the hash with one from the list above):

```sql
SELECT version, os, SUM(count) AS errors FROM error_traces
WHERE hash = 'eb78dee19e5ea0e2' AND day >= date('now','-30 day')
GROUP BY version, os ORDER BY errors DESC
```

Because there is no identifier, the counts say how often a feature is used, not by how many people. The number of people comes from the release download counts (above).

## Setting it up (once)

1. Create a Cloudflare API token with _Workers Scripts: Edit_ and _D1: Edit_ for your account.
2. Add the repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `ANALYTICS_SUMMARY_TOKEN` (any long random string, for `/v1/summary`).
3. Merge to `main`. [`analytics-deploy.yml`](../.github/workflows/analytics-deploy.yml) tests the Worker, creates the D1 database if it is missing, applies the migrations (in order: `0001_counters.sql`, then `0002_error_traces.sql` for error traces), deploys and sets the summary token. Without the secrets the deploy job is skipped with a warning.
4. Copy the Worker address from the job log (`https://smart-beat-analytics.<account>.workers.dev`) and add the repository **variable** `ANALYTICS_URL` = that address + `/v1/batch`. The next release build uses it ([`release.md`](release.md)).

### Deploy order: the Worker before the app

The Worker refuses a request with a field it does not know (`400`), and an app that cannot upload keeps its counters and tries again later, so a build that sends `traces` must never reach users before the Worker that accepts them. Order: merge the Worker change to `main` (the workflow applies migration `0002` and deploys the new Worker), check that the `Analytics Worker` run on `main` finished, and only then tag and publish the release that sends error traces ([`release.md`](release.md)). The new Worker still accepts the batches of older apps (no `traces`) unchanged. Without the deploy secrets, run `pnpm exec wrangler d1 migrations apply smart-beat-analytics --remote` and `pnpm exec wrangler deploy` in `analytics/` yourself first.

## Trying it locally

No Cloudflare account or secrets needed: run the Worker with a local D1 database and build the app against it.

```bash
cd analytics
printf 'ANALYTICS_SUMMARY_TOKEN=local-dev-token\n' > .dev.vars   # git-ignored
pnpm exec wrangler d1 migrations apply smart-beat-analytics --local
pnpm exec wrangler dev --port 8787 --ip 127.0.0.1
```

In another terminal, from the repository root:

```bash
SMART_BEAT_ANALYTICS_URL=http://127.0.0.1:8787/v1/batch SMART_BEAT_INSTALLER=dmg pnpm tauri build
curl -s -H 'Authorization: Bearer local-dev-token' 'http://127.0.0.1:8787/v1/summary?days=1' | jq
```

Use the app, then read the summary. The app uploads at startup and then at most hourly.

## Tests

Worker: `pnpm --dir analytics test` (the real SQL runs on Node's built-in SQLite, with every migration applied; `test/traces.test.ts` covers the error traces: accepting, grouping by hash, dropping bad traces, the caps, retention, the upgrade from `0001` to `0002` and `top_errors`). Rust: `src/telemetry.rs` unit tests (counting, offline, 30-day cap, upload shape against a local test server, off switch), `tests/ipc.rs` (commands) and `tests/library.rs` (the only network client is `ureq`, there is no hard-coded address, the content security policy and capabilities stay closed). UI: `src/lib/telemetry.test.ts`, the Settings dialog, the startup notice and `e2e/analytics.spec.ts`.

To see the failure counters without a build, send a batch by hand and read the summary (the Rust integration test `panic_counter` and the Worker tests cover the rest):

```bash
curl -s -X POST http://127.0.0.1:8787/v1/batch -H 'Content-Type: application/json' -d \
  '{"version":"1.1.0","os":"macos","installer":"dmg","counts":[{"day":"'"$(date -u +%F)"'","event":"error","format":"audio:io","count":1},{"day":"'"$(date -u +%F)"'","event":"panic","format":"stems","count":1}]}'
curl -s -H 'Authorization: Bearer local-dev-token' 'http://127.0.0.1:8787/v1/summary?days=1' | jq '.formats'
```

A detail outside the lists (`"format":"audio"` for `error`, free text for either) is answered with `400`.

To try an error trace the same way (the hash is the first 16 hex characters of `printf 'audio_start\nsrc/audio/mod.rs:123' | shasum -a 256`):

```bash
curl -s -X POST http://127.0.0.1:8787/v1/batch -H 'Content-Type: application/json' -d \
  '{"version":"1.3.1","os":"macos","installer":"dmg","counts":[{"day":"'"$(date -u +%F)"'","event":"error","format":"audio:audio","count":1}],"traces":[{"day":"'"$(date -u +%F)"'","format":"audio:audio","hash":"eb78dee19e5ea0e2","frames":["audio_start","src/audio/mod.rs:123","src/lib/tauri.ts:650:12"],"ext":"mp3","count":1}]}'
curl -s -H 'Authorization: Bearer local-dev-token' 'http://127.0.0.1:8787/v1/summary?days=1' | jq '.top_errors'
```

A trace that breaks the rules (a path, a URL, a wrong hash) is not an error: the answer is still `200`, the counter is stored and the trace is dropped.
