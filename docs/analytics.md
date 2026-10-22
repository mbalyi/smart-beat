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
    { "day": "2026-10-10", "event": "export", "format": "pdf", "count": 1 }
  ]
}
```

- `os`: `macos`, `windows` or `linux`.
- `installer`: `dmg`, `windows`, `appimage` or `linux-pkg`. The build knows its OS family; on Linux the app tells an AppImage (the `APPIMAGE` variable) from a system package. `.msi` and `.exe`, or `.deb` and `.rpm`, cannot be told apart (one build per OS), so use the download counts of the GitHub release assets for that split:

  ```bash
  gh api repos/mbalyi/smart-beat/releases --jq '.[].assets[] | {name, download_count}'
  ```

- `format`: a fixed detail allowed for that event. For `open_file`, `export`, `save` and `save_as`, a known extension (`gp3`, `gp4`, `gp5`, `gpx`, `gp`, `mid`, `midi`, `pdf`, `wav`, `m4a`, `mp3`, `musicxml`, `ogg`, `flac`, `txt`, `png`).
- Never sent: song or file names, titles, sound names, tempo or note values, volumes, anything typed, an IP address (the server does not store it), a user or install id.

## Counted features

`app_start`, `play`, `pause`, `stop`, `loop_on`, `speed_trainer_start`, `metronome_on`, `count_in_on`, `practice_mix` (focusing a track), `sound_change` (instrument sounds, presets, sound set), `open_file`, `export`, `save`, `save_as`, `mixer_open`, `effect_pedal` (changing a track's or the master effect chain), `sound_library_import`, `edit` (once per edit), `undo`, `redo`, `new_song`, `track_add`, `track_delete`, `solo_track`, `mute_track`, `tempo_change`, `transpose`, `copy_paste`, `chord_insert`, `notation_mode_switch`, `tuner`, `fretboard_view` / `piano_view` (the instrument view on a stringed track / on any other), `update_check`, `update_installed`, `theme_dark`, `theme_light`, `shift_select` (extending a score selection with Shift), `copy`, `cut`, `delete_selection`, `loop_selection`, `practise_selection`, `play_selection` (the score menu's selection actions), `restart_on_stop_on` / `restart_on_stop_off` (the "Auto-restart" practice option) and `restart_on_stop_used` (Stop sent the next Play back to the loop start) and `record_to_tab` (a finished Record to Tab take). Added in 1.0.1 (details below): `soundfont_select`, `play_soundfont`, `soundfont_download`, `soundfont_import`, `record_to_tab_start`, `record_to_tab_file`, `drum_normalize`, `track_duplicate`, `practice_speed`, `practice_range`, `speed_trainer_stop`, `speed_trainer_hold`, `practice_view`, `tour_start`, `tour_finish`, `tour_skip` and `tour_close`. Added in 1.0.2: `continuous_view` (switching the score to the continuous layout) and `multi_track_view` (stacking two or more tracks in it). Added in 1.1.0 (details below): `ai_install`, `ai_rights_confirmed`, `ai_transcribe_start` and `ai_transcribe_file`.

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

Details are optional so older app batches still work. `save` and `save_as` also keep accepting file extensions sent by existing clients. Other events accept no detail. The wire field and database column keep the name `format`; no database migration is needed. Plugin names, paths, amp model or IR ids and device labels are never counted.

Pedal add, remove and reorder counters cover buttons, keyboard shortcuts and drag and drop. `effect_pedal` counts loading a pedalboard preset, once per action, and never knob moves. `plugin_editor_open` counts a successful editor open. `plugins_on` counts the user's opt-in action, not restoring the saved preference. `audio_transcribe` counts a completed Import from Audio transcription, even if the result is not imported. `settings_open` counts an explicit user open, not the automatic usage notice. `audio_input_change` counts choosing a different input, and `piano_model_download` counts starting a download, including retries.

Sound sets (1.0.1): `soundfont_select` counts picking one in Instrument sounds, and `play_soundfont` counts every time playback starts, also after a pause, so we learn what people listen with and not only what they picked. A SoundFont the user imported is counted as `custom`, never by its name or file; `soundfont_download` and `soundfont_import` count adding one. `record_to_tab_start` counts a live take that has begun and `record_to_tab_file` an audio file turned into tab, each per instrument, apart from `record_to_tab` (a finished take). `drum_normalize` counts Normalize drum notation, `track_duplicate` the Duplicate track action (copying a track to another instrument is `copy_to_instrument`). Practice: `practice_speed` and `practice_range` count a speed or bar-range change (including dragging bars in the score), `speed_trainer_stop` and `speed_trainer_hold` stopping or holding the Speed Trainer, `practice_view` entering Practice View; switching a tool off is not counted. Tours: `tour_start` counts a guided tour that begins (also when a part-way tour is continued), `tour_finish` one finished on its last step or by picking the next tour, `tour_skip` one skipped (or "Skip for now" on the start page, for `main`), and `tour_close` one closed part-way; the detail is the tour id, sub-tours separately. MuScriptor (1.1.0): `ai_install` counts a finished model download (the size is the detail), `ai_rights_confirmed` the moment a user ticks that they only use music they have the rights to, and `ai_transcribe_start` (a live take) and `ai_transcribe_file` (an audio file, in Record to tab or Import from Audio) count every start of an AI transcription. Their detail says whether that confirmation is on file (`rights_confirmed`); the app refuses to run the AI engine without it, so `rights_unconfirmed` should stay at zero and is counted only to prove that. No file, name, path or audio is ever part of a counter.

## How it works

- **In the app.** `track()` asks the Rust core to add 1 to a per-day counter in `usage.json` (app data folder). No event log, no timestamps. The core uploads all counters in one batch on a background thread (5 s timeout). At launch it uploads straight from Rust and ignores the hourly pause. After that, uploads run in the background at most hourly, counted from the last _successful_ upload. Only what the server acknowledged with a 2xx is removed, so offline use is simply sent later. A failed upload starts only a 60 s back-off (`RETRY_AFTER`), so the next tracked action retries. A final batch is sent when the app quits or the last window closes; it ignores the pauses and has one 5 s budget in total, including the wait for an upload that is still running; unsent counters wait for the next launch. A failure writes one debug line to stderr with the HTTP status or error kind only, never counters or the address. At most 30 days are kept locally. The upload runs in Rust (`ureq`); the page never makes a network request, so the content security policy stays closed.
- **Off switch.** Help › Settings… › _Share anonymous usage counts_. Switching it off also deletes unsent counters. On a first run of a build that can send, a one-time notice says so.
- **When nothing is sent.** Development builds and pull-request builds have no address (`SMART_BEAT_ANALYTICS_URL` is set only by the release workflow), the setting is off, or the user is in a browser.
- **The server.** A Cloudflare Worker with a D1 database ([`analytics/`](../analytics)). It validates every field against the whitelists, adds the counts to one row per `(day, event, format, version, os, installer)` and stores nothing else: no IP address, user agent or request time. Cloudflare itself sees the connection (IP address) while it is made, as any web host does. Counters older than six months are deleted by a daily scheduled job.

## Reading the numbers

`GET /v1/summary?days=30` with the header `Authorization: Bearer <ANALYTICS_SUMMARY_TOKEN>` returns totals per event, per `event format`, per installer, per OS and per version:

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

Because there is no identifier, the counts say how often a feature is used, not by how many people. The number of people comes from the release download counts (above).

## Setting it up (once)

1. Create a Cloudflare API token with _Workers Scripts: Edit_ and _D1: Edit_ for your account.
2. Add the repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `ANALYTICS_SUMMARY_TOKEN` (any long random string, for `/v1/summary`).
3. Merge to `main`. [`analytics-deploy.yml`](../.github/workflows/analytics-deploy.yml) tests the Worker, creates the D1 database if it is missing, applies the migrations, deploys and sets the summary token. Without the secrets the deploy job is skipped with a warning.
4. Copy the Worker address from the job log (`https://smart-beat-analytics.<account>.workers.dev`) and add the repository **variable** `ANALYTICS_URL` = that address + `/v1/batch`. The next release build uses it ([`release.md`](release.md)).

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

Worker: `pnpm --dir analytics test` (the real SQL runs on Node's built-in SQLite). Rust: `src/telemetry.rs` unit tests (counting, offline, 30-day cap, upload shape against a local test server, off switch), `tests/ipc.rs` (commands) and `tests/library.rs` (the only network client is `ureq`, there is no hard-coded address, the content security policy and capabilities stay closed). UI: `src/lib/telemetry.test.ts`, the Settings dialog, the startup notice and `e2e/analytics.spec.ts`.
