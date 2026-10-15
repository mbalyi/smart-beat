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
   in the block, so the song recalls it. Preset changes apply off the audio
   thread. Structural chain changes create new instances using the saved
   settings, so save native-editor changes before adding or moving pedals.
   Cold module loads can take a while.

## How it stays stable

- **One helper process per loaded plugin.** The plugin itself always runs in
  the plugin helper (`src-tauri/src/bin/vst3-host-helper.rs`), never in the
  engine or the app, so a crashing plugin cannot take either down. The VST3
  path delegates to `vst3-host`; the CLAP path lives in
  `vst3-host-helper/clap_voice.rs` behind the same calls. Host and helper talk
  through shared protocol types. Lifecycle and small processing requests use
  JSON on stdin/stdout; stereo samples stay in a fixed-size shared-memory
  mapping. The host retains its private temporary backing file until the
  helper exits. A protocol version check rejects incompatible helpers. The helper
  claims the protocol channel away from stdout before loading anything,
  because third-party plugins print and a stray line would desynchronise
  every later command from its reply.
- **The engine drives audio, not the plugin's extras.** The worker sends
  stereo blocks in and reads stereo blocks out, plus lifecycle, latency, and
  preset save/load. The plugin never needs anything back from the host: CLAP
  host callbacks are no-ops. Unsupported operations answer with a clear error,
  never silence.
- **The audio thread never waits.** It drops input blocks into a slot and
  accepts output only for the immediately following engine block, both with
  `try_lock`. Buffers and native mutexes are initialized off the audio thread.
  An oversized block or a late answer passes dry unchanged; late output is
  discarded rather than played at an unreported delay.
- **Hang, crash, and timeout go dry too.** One audio block may take 2 s before
  it counts as hung; loading a plugin or its state may take 20 s; a scan probe
  may take 15 s. On failure the worker kills or respawns the helper and
  recovers in the background (reload, restore state, restart) while the block
  keeps passing dry audio.
- **Latency is reported, not hidden.** Added latency is the plugin's own
  latency plus one engine block for the handover
  (`PluginEffect::latency_samples`). The UI shows it under the block
  ("TONE3000 · +0.6 ms") from the live block status (latency, health).
- **Each block owns an independent instance.** Track, sound and slot address
  editor/status requests; the plugin path never identifies a running
  instance. The registry holds weak references. Dropping the final owner
  releases the worker and kills/reaps its helper. Offline exports use a
  separate pool and wait for each result off the realtime thread, keeping
  their audio and sample rate separate from live playback.
- **The off switch gates existing blocks immediately.** It bypasses their
  audio as well as preventing new loads. Enabling plugins rebuilds chains
  omitted when the song opened with plugins off. The UI polls live status
  so failures after initial loading are visible.

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

- The shared mapping holds up to 4,096 stereo input/output frames. Larger
  realtime blocks pass dry without allocating. Small JSON requests still
  wake the helper; audio samples are never serialized into those requests.
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
the running executable in development. Tauri ships it as the separately
named `smart-beat-plugin-helper` sidecar, so staging cannot overwrite Cargo's
development binary. Its location is overridable with
`SMART_BEAT_PLUGIN_HELPER` for tests and deployments.

## Testing

- `cargo test --lib audio::` runs the unit tests: format-by-path, the
  disabled-pool refusal, the missing-plugin message, the
  push/take handover slots, and a chain test proving a plugin block with no
  answer passes audio through dry.
- `cargo test --test plugin_host` builds an original tiny CLAP gain plugin
  with `rustc` and runs it through the real helper in CI. It checks independent
  tracks/sounds/slots, preset isolation and reset, disable/re-enable, worker
  release, zero callback allocations, and crash/timeout recovery. No installed
  plugins are required. Shared-mapping and late-output unit tests cover the
  wire shape and the one-block deadline.
- `cargo test --lib real_plugins -- --ignored` runs end to end through the
  real helper against TONE3000 when it is installed at
  `/Library/Audio/Plug-Ins/{VST3,CLAP}` (load, process a 220 Hz tone, check
  latency, round-trip state), and skips quietly anywhere else, including CI.

## Licences

- VST3 hosting uses `vst3-host` (MIT); CLAP hosting uses `clack-host` and
  `clack-extensions` (MIT OR Apache-2.0). All three satisfy `deny.toml`, which
  allows MIT and Apache-2.0.
- Shared-memory mapping uses `memmap2` (MIT OR Apache-2.0); the test fixture
  uses the existing `clap-sys` ABI definitions (MIT OR Apache-2.0).
- The helper binary derives from `vst3-host` 0.10.0 (MIT); attribution is in
  `public/third-party-licenses.txt`, shipped with the installer and shown in
  Help › Open-Source Licenses (see [`licensing.md`](licensing.md)).
- The plugins themselves stay the user's own files: Smart Beat never ships,
  uploads, or redistributes them.
