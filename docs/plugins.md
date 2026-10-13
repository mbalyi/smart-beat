# Third-party plugins: VST3 and CLAP (#80)

Any VST3 or CLAP plugin you own (amp sims, pedals, cabinets, effects) can be a
pedalboard block. Plugins are **opt-in and off by default**: they are
third-party code running outside the audio engine, so the switch in the
pedalboard dialog ("Use third-party plugins") warns that each runs isolated
outside the app and a crashing plugin cannot take the song down. The backend
starts switched off on every launch; the UI remembers the choice on the
computer (`smart-beat.plugins-enabled`) and pushes it in. Outside the desktop
app plugins are unavailable ("Third-party plugins need the desktop app").

## Using them

1. Open the pedalboard and switch **Third-party plugins** on.
2. Click **Scan for plugins**. The scan walks the standard folders below and
   probes each file in a throwaway helper (eight at a time); files that crash
   or time out are skipped with a note, never aborting the scan.
3. Drag a listed plugin onto the board (or use its Add button), like any other
   block. The list shows name, vendor, version, and format.
4. Open the block's editor to tweak it. This is the plugin's own window,
   owned by the helper process, not a Smart Beat panel. A plugin with no
   editor reports "This plugin has no editor window"; CLAP editors need the
   macOS helper window.
5. Use **Save settings** on the block. This stores the plugin's current preset
   in the block, so the song recalls it. Keeping the same plugin on a block
   reuses its running worker and applies the new preset to it off the audio
   thread; swapping to another plugin loads a new worker (loading may take a
   while on a cold module load).

## How it stays stable

- **One helper process per loaded plugin.** The plugin itself always runs in
  `vst3-host-helper` (`src-tauri/src/bin/vst3-host-helper.rs`), never in the
  engine or the app, so a crashing plugin cannot take either down. The VST3
  path delegates to `vst3-host`; the CLAP path lives in
  `vst3-host-helper/clap_voice.rs` behind the same calls. Host and helper talk
  over one JSON protocol (`HostCommand`/`HostResponse` from `vst3_host`) on
  stdin/stdout, so they cannot disagree about the wire format. The helper
  claims the protocol channel away from stdout before loading anything,
  because third-party plugins print and a stray line would desynchronise
  every later command from its reply.
- **The engine drives audio, not the plugin's extras.** The worker sends
  stereo blocks in and reads stereo blocks out, plus lifecycle, latency, and
  preset save/load. The plugin never needs anything back from the host: CLAP
  host callbacks are no-ops. Unsupported operations answer with a clear error,
  never silence.
- **The audio thread never waits.** It drops input blocks into a slot and
  picks up the latest finished output, both with `try_lock`. If the worker is
  behind, the block passes audio through dry unchanged.
- **Hang, crash, and timeout go dry too.** One audio block may take 2 s before
  it counts as hung; loading a plugin or its state may take 20 s; a scan probe
  may take 15 s. On failure the worker kills or respawns the helper and
  recovers in the background (reload, restore state, restart) while the block
  keeps passing dry audio.
- **Latency is reported, not hidden.** Added latency is the plugin's own
  latency plus one engine block for the handover
  (`PluginEffect::latency_samples`). The UI shows it under the block
  ("TONE3000 · +0.6 ms") from the live block status (latency, health).
- **Workers are shared and weakly held.** Blocks using the same plugin share
  one worker; a new sample rate reconfigures it in place (keeping its
  settings) instead of reloading. Dropping the last such block shuts its
  helper down. A seek drops stale output so only newer blocks count.

## What is stored

A plugin block keeps `format` (`vst3`/`clap`, picked by path: a `.clap` file
or anything inside a `.clap` bundle is CLAP, everything else VST3), the bundle
path from the scan, the display name, and the plugin's own preset bytes as
base64 (`state`, empty for the default preset). Chains live in the song's
mixer settings, so the preset travels with the song.

When the song opens without the plugin installed, the block is left out and
the song plays without it, with a message ("This plugin is not installed …
Install it, then it plays again"). Corrupt saved settings report the same way
("saved settings are corrupt. Open its editor and save them again") instead of
failing the song. Any block that cannot load records a `BlockProblem` shown
next to it in the UI; only running blocks process audio, so a dead plugin
block is silence-free dry signal or an absent block, never a crash.

## Limits

- Audio crosses the process boundary as one base64 JSON block per call, not
  shared memory: at 64-frame engine blocks the copy is sub-millisecond, and
  the timeout bounds it. A shared-memory transport is a possible follow-up.
- CLAP editor windows only work with the macOS helper. Elsewhere the helper
  has no window to attach to, and opening one reports that plainly.
- CLAP loads use a fixed 120 BPM, 4/4 musical context: the engine sends
  audio, not transport.
- The scan only looks in the folders above: one level, `.vst3` and `.clap`
  entries. Anything else (custom install paths, other formats) is not found.

## Formats and scan folders

The scan looks for `.vst3` bundles and `.clap` files or bundles in:

| OS      | System folders                                          | User folders                                                     |
| ------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| macOS   | `/Library/Audio/Plug-Ins/VST3`, `…/CLAP`                | `~/Library/Audio/Plug-Ins/VST3`, `~/Library/Audio/Plug-Ins/CLAP` |
| Windows | `C:\Program Files\Common Files\VST3`, `…\CLAP`          | `%LOCALAPPDATA%\Programs\Common\VST3`, `…\CLAP`                  |
| Linux   | `/usr/lib/vst3`, `/usr/local/lib/vst3`, same for `clap` | `~/.vst3`, `~/.clap`                                             |

On macOS a CLAP plugin is a `.clap` bundle wrapping the library (a path
inside the bundle still counts as CLAP). The helper binary is found next to
the running executable (Tauri ships it as a sidecar), overridable with
`SMART_BEAT_PLUGIN_HELPER` for tests and deployments.

## Testing

- `cargo test --lib audio::` runs the unit tests: format-by-path, the
  disabled-pool refusal, the missing-plugin message, the
  push/take handover slots, and a chain test proving a plugin block with no
  answer passes audio through dry.
- `cargo test --lib real_plugins -- --ignored` runs end to end through the
  real helper against TONE3000 when it is installed at
  `/Library/Audio/Plug-Ins/{VST3,CLAP}` (load, process a 220 Hz tone, check
  latency, round-trip state), and skips quietly anywhere else, including CI.

## Licences

- VST3 hosting uses `vst3-host` (MIT); CLAP hosting uses `clack-host` and
  `clack-extensions` (MIT OR Apache-2.0). All three satisfy `deny.toml`, which
  allows MIT and Apache-2.0.
- The helper binary derives from `vst3-host` 0.10.0 (MIT); attribution is in
  `public/third-party-licenses.txt`, shipped with the installer and shown in
  Help › Open-Source Licenses (see [`licensing.md`](licensing.md)).
- The plugins themselves stay the user's own files: Smart Beat never ships,
  uploads, or redistributes them.
