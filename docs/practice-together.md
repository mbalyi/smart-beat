# Practice together

Issue: [#158](https://github.com/mbalyi/smart-beat/issues/158) (first step towards [#94](https://github.com/mbalyi/smart-beat/issues/94))

Two Smart Beat apps play the same tab in time. The host's Play, Pause, Stop and position start for both at the same moment, and the speed, loop, metronome and count-in are shared. Each computer makes its own sound: no audio or tab is ever sent. Track mute and solo stay local. Playback starts at an agreed instant on a shared clock, not when a message arrives.

Menu: Playback › Practice Together. A chip in the toolbar shows the sync quality (± ms) and opens the dialog.

## How it fits together

All session logic is in the page (TypeScript), so the clock maths, the scheduler and the player share one clock (`performance.now()`). Rust and WebRTC only carry short JSON texts (frames).

```
Practice together dialog + toolbar chip
        │
   usePracticeTogether (src/hooks/use-practice-together.ts)
        │
   Session ── ClockEstimator, LatencyTracker, presets      src/lib/practice-together/
        │         SharedTransport ── ScorePlayer (alphaSynth or native engine)
        │
   PeerTransport ─┬─ LAN:       Rust TCP link        src-tauri/src/practice.rs
                  └─ Internet:  WebRTC data channel  rtc.ts
                                 setup messages via   src-tauri/src/practice_signal.rs
                                 the signaling Worker signaling/
```

- **Same network (LAN).** The host listens on a free TCP port (`Link::host`). The guest connects with a room code (`Link::join`) and presents the secret token in its first frame. Frames are a 4-byte length and UTF-8 text, at most 64 KiB; a length of 0 is a keep-alive every 2 s that is never passed on. A connection silent for 8 s is dead. A guest whose connection drops retries with a growing pause for 20 s. Rust emits `practice-frame` and `practice-state` events to the page; the page calls `practice_host`, `practice_join`, `practice_send` and `practice_leave`. No new crate: standard sockets and threads.
- **Over the internet.** The two apps meet in a room of the signaling Worker, swap a WebRTC offer, answer and candidates, then talk directly over one ordered data channel (`rtc.ts`). The requests to the Worker are made from Rust (`practice_signal.rs`, `ureq`), not from the page, so the content security policy stays closed. The only ICE server is `stun:stun.cloudflare.com:3478`; there is no TURN relay, so a strict firewall can block a connection. After 25 s without an open channel the app says so. A failed connection is restarted by the host (ICE restart).
- **Signaling Worker** ([`signaling/`](../signaling)). A Cloudflare Worker with one Durable Object per room. It holds two mailboxes in memory, relays setup messages and nothing else, and deletes the room 10 minutes after it was made. Limits: 8 KiB per message, 200 messages per room, one guest. Long polls last up to 20 s. It keeps no database and no log of room codes.

## Room codes and who may join

| Where    | Code                                                       | Example                    |
| -------- | ---------------------------------------------------------- | -------------------------- |
| Network  | 20 characters: host IPv4 address, port and a 48-bit token  | `ABCD-EFGH-JKMN-PQRS-TVWX` |
| Internet | 8 characters: the room in the Worker (tokens are separate) | `ABCD-EFGH`                |

The alphabet is Crockford base 32 (no I, L, O or U); typed codes ignore case, dashes and spaces, and read I and L as 1 and O as 0. The code can also be shared as `smartbeat://join/<code>`.

Only explicitly joined players take part: a wrong token is refused (after 20 wrong tries the host stops listening), and the host sees the guest's name and must press **Let in** before anything else happens. Another player cannot take over a running session: a second `hello` with a different name and session is answered `busy`.

## Protocol

`src/lib/practice-together/protocol.ts`. Every frame is `{ v, n, msg }`: protocol version, a counter per sender and the message. The two apps speak the lower of their versions; frames over 16 K characters, malformed frames and unknown types are dropped.

| Message             | Purpose                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `hello` / `welcome` | The guest introduces itself (name, capabilities, score fingerprint); the host answers with the session id                         |
| `refuse`            | `version`, `score`, `declined` or `busy`                                                                                          |
| `ping` / `pong`     | Four timestamps for the clock exchange                                                                                            |
| `cmd`               | `play`, `pause`, `stop`, `seek` or `settings`, with tick, speed, loop, metronome, count-in and the host time `at` it takes effect |
| `ready` / `abort`   | The guest is (not) ready for command `id`; the host calls a start off                                                             |
| `state`             | The host's position (score ms, as heard) and whether it plays, every second                                                       |
| `report`            | The guest's sync error, round trip and drift, for the host's display                                                              |
| `bye`               | Leaving                                                                                                                           |

The score fingerprint is the SHA-256 of the alphaTex text of the open score, edits included, so two apps with the same file and no different edits match whatever the file format.

## The shared clock

`clock-sync.ts`. The guest pings the host with the NTP four-timestamp exchange: `offset = ((t1 - t0) + (t2 - t3)) / 2` and `rtt = (t3 - t0) - (t2 - t1)`. The host's `performance.now()` is the session clock.

- The last 40 round trips are kept. The estimate uses the 10 with the smallest RTT (their delay is the most symmetric) and drops those whose offset is more than three scaled MADs from the median (at least 1 ms). A negative RTT is refused.
- A skew (clock speed difference) is fitted over a session longer than 10 s with at least 6 samples; a fit beyond 500 ppm is ignored as broken.
- The estimate is trusted after 4 accepted round trips. A start waits until both sides have one.
- Pings: a burst of 8, 120 ms apart, then one every 1 to 3 s depending on the audio quality preset.
- **Sync quality:** ± error = half the best RTT plus the spread of the offsets. Excellent up to 5 ms, Good up to 15 ms, otherwise Unstable. Syncing is shown before 4 round trips.
- **Too poor:** an error above 40 ms or a 95th percentile RTT above 250 ms warns the group; it does not forbid starting.
- **Sleep and wake:** a ping timer that is more than 3 s late means the computer slept; the estimate is thrown away and measured again.

## Lead time and audio quality

`latency.ts`, `quality-presets.ts`. The start is scheduled `leadMs = clamp(p95(rtt) / 2 + k × jitter + 100 ms, floor, 3000 ms)` after the command, where 100 ms is the time to prepare. Jitter is the RFC 3550 style running mean of the change between neighbouring round trips.

| Preset   | Lead floor | k   | Ping | Drift left alone | Largest nudge | Native buffer |
| -------- | ---------- | --- | ---- | ---------------- | ------------- | ------------- |
| Tight    | 250 ms     | 2   | 1 s  | 12 ms            | ±1 %          | 128 frames    |
| Balanced | 450 ms     | 3   | 2 s  | 20 ms            | ±2 %          | 256 frames    |
| Safe     | 900 ms     | 4   | 3 s  | 40 ms            | ±2 %          | 512 frames    |

**Auto** (the default) picks Tight when the error is at most 5 ms, the 95th percentile RTT at most 25 ms and the jitter at most 3 ms; Balanced up to 15 ms and 100 ms; Safe beyond. It is Balanced until 4 round trips are measured. The choice is remembered in `localStorage` (`smart-beat:practice-together:quality`). The sound is always rendered locally; the preset never changes what is streamed (nothing is).

## Starting together

`session.ts`, `shared-transport.ts`.

1. The host sends `cmd` with `at = now + leadMs` and prepares itself: the settings go into the practice state, and a `play` or `seek` moves to the tick.
2. The guest converts `at` to its own clock and prepares (it refuses with `ready: false` when less than 20 ms is left). It answers `ready`.
3. If both are ready 30 ms before `at`, both start: a timer, then a tight loop for the last 12 ms. Each fires early by its own output latency, so the sound is heard at the same moment. If either is not ready, the host sends `abort` and nobody starts; the group is told.
4. A count-in is part of the schedule: `at` is when the count-in begins.

The host's speed, loop, metronome and count-in follow with a `settings` command whenever they change. A guest's Speed Trainer is ended (the host runs it and its speeds are sent).

## Staying in time

The host reports its position every second (`state`). The guest compares it with its own, taking the age of the report into account, and takes the median of the last 5 readings (at least 3). Within the preset's tolerance nothing happens. Beyond it the speed is nudged by `drift / 3 s` of a unit, capped by the preset (1 or 2 %); beyond 150 ms the cap is 5 %. Ahead: slower; behind: faster. The nudge is a separate multiplier on top of the practice speed, so the Speed Trainer is unaffected. There are no jumps.

## When something goes wrong

| Case                           | What happens                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Different version of the score | Refused at joining; changing the score later shows a warning and the host cannot start                                                  |
| Connection drops               | "Reconnecting…" for 20 s; the guest says hello again with its session id and the clocks are measured again; after 20 s the session ends |
| Computer sleeps                | The clock is measured again; a message says so                                                                                          |
| A player is not ready in time  | The start is called off for both and a message says so                                                                                  |
| Quality too poor               | A warning in the dialog, the chip and a toast                                                                                           |
| Other app too old or too new   | Refused with `version`                                                                                                                  |
| Guest leaves                   | The host goes back to waiting for a new guest                                                                                           |
| Host leaves                    | The session ends for the guest                                                                                                          |

## Privacy

- The tab, the audio and the playback never go through any server. In a session they travel only between the two computers. The meeting service sees only setup messages.
- Room codes and tokens are never part of the usage counters ([`analytics.md`](analytics.md)); nothing about Practice together is counted.
- **Same network:** nothing leaves your network. The host's local address is inside the code.
- **Over the internet:** the app contacts the signaling Worker (to make or join a room) and `stun.cloudflare.com` (to learn its public address). The other player can then see that address in the WebRTC connection. This is said in the dialog. The room is deleted after 10 minutes.
- The user's name is typed in the dialog and shown to the other player only.

## Permissions of the operating system

- **macOS:** the first connection triggers the Local Network prompt. The text comes from `NSLocalNetworkUsageDescription` in `src-tauri/Info.plist`. If it was refused, allow Smart Beat in System Settings › Privacy & Security › Local Network.
- **Windows:** Windows Defender Firewall asks once when the host starts listening. Allow private networks.
- **Linux:** a firewall may block incoming connections to the host's port; the dialog shows the address that is listened on. WebRTC (Over the internet) needs a WebKitGTK built with it; the option is hidden where `RTCPeerConnection` is missing.

## Setting up the signaling Worker (once)

Only "Over the internet" needs it; without it the app offers the same network only.

1. Add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the same ones the analytics Worker uses). The token needs _Workers Scripts: Edit_.
2. Merge a change under `signaling/` to `main`. [`signaling-deploy.yml`](../.github/workflows/signaling-deploy.yml) tests it and runs `wrangler deploy`. Without the secrets the deploy job is skipped with a warning.
3. Set the repository **variable** `SIGNALING_URL` (Settings › Secrets and variables › Actions › Variables) to the Worker's address, for example `https://smart-beat-signaling.<account>.workers.dev`, without a trailing path. `release.yml` bakes it into release builds as `SMART_BEAT_SIGNALING_URL`. Without it, and in pull requests, the build has no address and the option is not offered.

Locally: `pnpm --dir signaling dev` runs the Worker; build the app with `SMART_BEAT_SIGNALING_URL=http://127.0.0.1:8787` set to try it. Tests: `pnpm --dir signaling test`.

## Measured error

What is measured so far (automated, one computer):

- Rust link on loopback: the best of 20 round trips of a frame is under 20 ms (`src-tauri/tests/practice.rs`); typically well below 1 ms.
- Two simulated players with a 10 ms wire each way and clocks 7 s apart start within 3 ms of each other, on the host's clock (`shared-transport.test.ts`). The clock estimate finds a steady offset to within the test's resolution and follows a 200 ppm skew.

Not measured yet, and to be written here after the checks in [manual-checks.md](manual-checks.md):

- The start error of two real computers on the same Wi-Fi and on a cable (target: a few milliseconds plus the difference of the two output latencies).
- A 10 minute session without audible drift.
- Over the internet, and on Windows or Linux as the second system.

Limits:

- alphaSynth reports its position in chunks, so drift is found with a resolution of roughly a tenth of a second; the median of five readings and the tolerance absorb it. The native engine reports every 25 ms.
- alphaSynth has no scheduled start and a 500 ms buffer; its start error is the timer's (a millisecond or two) plus how well the output latency is known. Set the sync offset in the Inspector ([manual-checks.md](manual-checks.md), check 1) on both computers.
- WebRTC in WebKitGTK is unverified.
- No TURN relay: two computers behind strict firewalls cannot connect over the internet.
- Two players only; no audio streaming; no public matchmaking (those stay in #94).
