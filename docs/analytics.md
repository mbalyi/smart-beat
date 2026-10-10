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

- `format`: only with `open_file` and `export`, and only a known extension (`gp3`, `gp4`, `gp5`, `gpx`, `gp`, `mid`, `midi`, `pdf`, `wav`, `m4a`, `mp3`, `musicxml`, `ogg`, `flac`, `txt`, `png`).
- Never sent: song or file names, titles, sound names, tempo or note values, volumes, anything typed, an IP address (the server does not store it), a user or install id.

## Counted features

`app_start`, `play`, `pause`, `stop`, `loop_on`, `speed_trainer_start`, `metronome_on`, `count_in_on`, `practice_mix` (focusing a track), `sound_change` (instrument sounds, presets, sound set), `open_file`, `export`, `save`, `save_as`, `mixer_open`, `effect_pedal` (changing a track's or the master effect chain), `sound_library_import`, `edit` (once per edit), `undo`, `redo`, `new_song`, `track_add`, `track_delete`, `solo_track`, `mute_track`, `tempo_change`, `transpose`, `copy_paste`, `chord_insert`, `notation_mode_switch`, `tuner`, `fretboard_view` / `piano_view` (the instrument view on a stringed track / on any other), `update_check`, `update_installed`, `theme_dark`, `theme_light`.

The list is one Rust enum (`Event` in [`src-tauri/src/telemetry.rs`](../src-tauri/src/telemetry.rs)) mirrored by the UI (`TrackedEvent`, [`src/lib/telemetry.ts`](../src/lib/telemetry.ts)) and the Worker ([`analytics/src/events.ts`](../analytics/src/events.ts)); anything else is refused at each end. To count a new feature, add it in all three places and call `track("name")` where the user does it.

## How it works

- **In the app.** `track()` asks the Rust core to add 1 to a per-day counter in `usage.json` (app data folder). No event log, no timestamps. At startup and then at most hourly, the core uploads all counters in one batch on a background thread (5 s timeout). Only what the server acknowledged with a 2xx is removed, so offline use is simply sent later. Failures are silent. At most 30 days are kept locally. The upload runs in Rust (`ureq`); the page never makes a network request, so the content security policy stays closed.
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
