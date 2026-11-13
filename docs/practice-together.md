# Practice together

Issue: [#158](https://github.com/mbalyi/smart-beat/issues/158) (first step towards [#94](https://github.com/mbalyi/smart-beat/issues/94))

Up to ten Smart Beat apps (the host and nine guests) play the same tab in time. Play, Pause, Stop and the position (the host's, or a guest's request that the host carries out) start for everyone at the same moment, and the speed, loop, metronome and count-in are shared. Each computer makes its own sound: no audio is ever streamed. The tab, the audio lanes and the audio files of the lanes go straight from the host to the guests that need it (see "Sharing the tab"), never through a server. Track mute and solo stay local. Playback starts at an agreed instant on a shared clock, not when a message arrives.

Where to start it:

- **Start screen:** the **Practice together** button after Open saved stems. It asks first: _Start a new session_ (then pick the tab: a recent song, a file or a blank tab; the tab opens and its own dialog goes on with the connection) or _Join an existing session_ (a blank tab opens on the join form; the tab comes from the host). Code: `practice-together-launcher.tsx`, wired in `App.tsx` (`togetherIntent`).
- **An open tab:** the Users icon button beside Record to Tab, or Playback › Practice Together. The same first choice; the tab is the open one, so there is no step to pick it. Once a session exists the button turns into the chip that shows the sync quality (± ms) and reopens the dialog.

The dialog's look (`together-frame.tsx`): the logo is the title, the description sits above the stepper, and the feature picture (the one of the start screen's feature card) is at the top right with the cards flowing around it. Over the internet stays visible but disabled, with the reason beside it, while the build has no signaling service.

## How it fits together

All session logic is in the page (TypeScript), so the clock maths, the scheduler and the player share one clock (`performance.now()`). Rust and WebRTC only carry short JSON texts (frames).

```
Practice together dialog + toolbar chip
        │
   usePracticeTogether (src/hooks/use-practice-together.ts)
        │
   Session ── ClockEstimator, LatencyTracker, presets      src/lib/practice-together/
        │         SharedTransport ── ScorePlayer (alphaSynth with SoundFonts: a session always uses them)
        │
   PeerTransport ─┬─ LAN:       Rust TCP link        src-tauri/src/practice.rs
                  └─ Internet:  WebRTC data channel  rtc.ts
                                 setup messages via   src-tauri/src/practice_signal.rs
                                 the signaling Worker signaling/
```

- **Same network (LAN).** The host listens on a free TCP port (`Link::host`). The guest connects with a room code (`Link::join`) and presents the secret token in its first frame. Frames are a 4-byte length and UTF-8 text, at most 64 KiB; a length of 0 is a keep-alive every 2 s that is never passed on. A connection silent for 8 s is dead. A guest whose connection drops retries with a growing pause for 20 s. **A host keeps one connection per guest** (at most 16 at once, so a stranger with the code cannot hold more open). The host listens on the address in the code only (not on every network the computer is on), and a stranger gets little for its trouble: a new connection has 3 s _in all_ to present its token (one deadline for the whole handshake, not one per read, so a sender that dribbles a byte at a time is cut off), at most 8 handshakes run at once and at most 3 per address, and an address that sends 5 wrong tokens, or handshakes that never finish, within a minute is turned away for a minute. The guests already in stay in: wrong guesses never end the session. A thread that cannot be started is a refused connection, not a crash. Leaving while a guest is reconnecting leaves no connection behind (a link that was left takes no new connection), and a new session ends the old one first, so the page never takes the old link's last event for the new one's; every event carries the connection number (`conn`; 0 is the link itself), a new connection's state event carries the guest's address, and the host tells the guests apart by it. Rust emits `practice-frame` (`{ conn, text }`) and `practice-state` (`{ conn, state, detail }`) events to the page; the page calls `practice_host`, `practice_join`, `practice_send` (a host names the `conn`), `practice_kick` (end one guest's connection, and with `ban` turn its address away from then on) and `practice_leave`. No new crate: standard sockets and threads.
- **Over the internet.** The apps meet in a room of the signaling Worker, swap a WebRTC offer, answer and candidates, then talk directly over one ordered data channel each (`rtc.ts`): the host has one `RTCPeerConnection` per guest, and the Worker tells it which guest wrote each setup message. The requests to the Worker are made from Rust (`practice_signal.rs`, `ureq`), not from the page, so the content security policy stays closed. The only ICE server is `stun:stun.cloudflare.com:3478`; there is no TURN relay, so a strict firewall can block a connection. After 25 s without an open channel the app says so. A failed connection is restarted by the host (ICE restart).
- **Signaling Worker** ([`signaling/`](../signaling)). A Cloudflare Worker with one Durable Object per room. It holds a mailbox for the host and one for each guest in memory, relays setup messages and nothing else, and deletes the room 10 minutes after the host was last heard (and at the latest 12 hours after it was made, so a guest can come back to a long session). Limits: 8 KiB per message; 9 guests per room (ten players with the host); a mailbox only holds what its owner has not read yet (the `after` of a poll says what was read, and that is dropped); one guest may have 60 messages waiting for the host and may send 1000 in all, so it cannot use up the host's mailbox for the others; 30 joins per room in 5 minutes; and when the room is full, the seat of a guest that has not polled for 90 s goes to a newcomer. At most 10 rooms a minute per address are made (the Workers rate-limit binding `CREATE_LIMIT` in `signaling/wrangler.toml`; the Worker works without it, as in the tests, so the limit is the platform's). The secret of a poll goes in an `Authorization: Bearer` header, never in the address, so a log of addresses (Workers Logs, Logpush) would not hold it; the Worker names the problem in the `error` field of an answer (`denied`, `banned`, `no-guest`, `unknown`, `rate-limited`, ...) and the app reads that, not the bare status, so a guest that was only removed is not told it is blocked. A guest that joins is announced to the host (`joined`), which starts a connection to it. A guest says its own id when it joins, so the same app takes its old place again (the old token stops working); the host can remove a guest (`/kick`) and ban its id (the Worker refuses it from then on). **An internet ban is best-effort**: a guest chooses its own id, so an honest app is kept out and a modified one only until it picks another id (the Worker cannot know who a guest really is, and it does not keep addresses). What keeps strangers out is the room code; the host can end the session to change it. Long polls last up to 20 s. It keeps no database and no log of room codes.

## Room codes and who may join

| Where    | Code                                                       | Example                    |
| -------- | ---------------------------------------------------------- | -------------------------- |
| Network  | 20 characters: host IPv4 address, port and a 48-bit token  | `ABCD-EFGH-JKMN-PQRS-TVWX` |
| Internet | 8 characters: the room in the Worker (tokens are separate) | `ABCD-EFGH`                |

The alphabet is Crockford base 32 (no I, L, O or U); typed codes ignore case, dashes and spaces, and read I and L as 1 and O as 0. The host also gets the code as a `smartbeat://join/<code>` link, reserved for later: Smart Beat does not register or open such links yet, so the code is what is shared.

Only explicitly joined players take part: a wrong token is refused (after 20 wrong tries the host stops listening), and the host sees each guest's name and must press **Let in** before anything else happens. Several guests asking at once are asked about one at a time ("2 more are waiting"). Nobody can take over another player's place: a guest is known by its own id (a random 16-character text the app makes once and keeps in its own storage; it is only ever sent to the host and, over the internet, to the meeting service), not by its name.

### Up to ten players

`host-room.ts` (`HostRoom`) is the host's end of a session: a `Session` per guest (each measures its own clock, shares the tab and takes the guest's requests) and one place where the host's commands are turned into a single start. The limit is **ten players including the host**, so nine guests (`MAX_PLAYERS`); a tenth is told "The session is full" and turned away.

- **One command, every guest.** The host picks one start time for everyone: `at = now + the longest lead time any guest needs`, sends the same command (`cmd`, same id and `at`) to every guest that is in sync, prepares itself once and starts once. A guest that says it is not ready (or does not answer) in time misses _that_ start only; it is told (`abort`) and the others start. When the host is not ready, or no guest is, nothing starts (as with one guest). A guest that has another version of the tab is left out until the tab has arrived.
- **Per-guest sync.** Each seat is measured with its own clock exchange; the dialog lists every guest with its own quality (the guest's own estimate, as `report`), and the toolbar chip shows the worst. Round trip and "Starts ahead by" show the slowest.
- **The tab for everyone.** Each seat offers the host's tab to its guest on its own (pieces, checks, edits: see "Sharing the tab").
- **Requests from guests** go to the same place as the host's own buttons, so two guests pressing Play at once start one shared start.

### Coming back

A guest whose connection drops (a Wi-Fi blip, a closed lid) is given 20 s by its own app to get the line back. If the guest's app was closed or its battery died, the host keeps its place on the roster for **10 minutes** ("Connection lost: can rejoin"): the other players are not held up. The guest app remembers the last session it joined (kind and code, in its own storage, expiring after 6 hours; never in the usage counters) and offers **Rejoin** in the dialog after the session ended (a lost connection, or being kicked) and when the dialog is opened again. It joins the same code with the same guest id; the host recognises it, gives its place back without asking again, and measures the clocks again. Rejoin is not offered after the host ended the session, after a ban, or after the guest pressed Leave on purpose. The code works as long as the host's session does: on the same network the host's socket, over the internet while the host keeps polling the meeting room (up to 12 hours).

### Kick and ban

The host's roster has **Kick** and **Ban** for every guest, each with a confirmation in the dialog (an inline question, no second window). A kick says "The host removed you from the session. You can join again with the code." and frees the place; the guest may come back, and is asked about again. A ban blocks the guest's id for the rest of the session and, where the transport knows it, its address (the same network: the host's Rust refuses the address; the meeting room refuses the id): "The host blocked you from this session." Both send a `bye` with the reason (`kicked` or `banned`) before the connection is closed. A new session lets everyone in again. A ban is as strong as the guest id: a guest that clears its app data gets a new id, which is why the same network also turns the address away. Over the internet it stays best-effort (see the signaling Worker above): the dialog says the host blocked the guest, and a modified app can still come back under another id until the host ends the session.

A guest does not need the host's tab beforehand. When its `hello` carries another score fingerprint (and the capability `tab`), the host lets it in as usual and then sends its tab (see "Sharing the tab"). Only a guest that cannot take a tab (an older Smart Beat) is refused with `score`.

## Protocol

`src/lib/practice-together/protocol.ts`. Every frame is `{ v, n, msg }`: protocol version, a counter per sender and the message. The two apps speak the lower of their versions; frames over 16 K characters, malformed frames and unknown types are dropped.

| Message             | Purpose                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `hello` / `welcome` | The guest introduces itself (name, capabilities, score fingerprint, its own `guest` id); the host answers with the session id     |
| `refuse`            | `version`, `score`, `declined`, `busy`, `full` (ten players) or `banned`                                                          |
| `ping` / `pong`     | Four timestamps for the clock exchange                                                                                            |
| `cmd`               | `play`, `pause`, `stop`, `seek` or `settings`, with tick, speed, loop, metronome, count-in and the host time `at` it takes effect |
| `ready` / `abort`   | The guest is (not) ready for command `id`; the host calls a start off                                                             |
| `state`             | The host's position (score ms, as heard) and whether it plays, every second                                                       |
| `report`            | The guest's sync error, round trip and measured drift, for the host's display                                                     |
| `request`           | A guest asks the host for `play`, `pause`, `stop` or `seek` (with a tick, while stopped)                                          |
| `bye`               | Leaving; from the host to a guest it removes, the reason `kicked` or `banned`                                                     |
| `tab-offer`         | The host offers its tab: name, size, number of pieces, SHA-256 of the file (`sha`) and the score fingerprint it matches (`key`)   |
| `tab-chunk`         | Piece `i` of the offer, as base64 (8 KiB of file, about 11 K characters: always inside a 16 K frame)                              |
| `tab-ack`           | The guest has the first `n` pieces; the host keeps at most 12 pieces ahead                                                        |
| `tab-done`          | The guest opened the tab (`ok`), or could not (`reason`); `reason: "have"` means it already had that version                      |
| `tab-abort`         | Either side stops an offer (`too-big`, `corrupt`, `checksum`, `unsupported`, `replaced`, ...)                                     |

The score fingerprint is the SHA-256 of the alphaTex text of the open score, edits included, so two apps with the same file and no different edits match whatever the file format. What each player sets for themselves does not count: a track's volume, balance, mute and solo, and which notation a staff shows (alphaTex writes them, so without this a mute made the two apps think they had different tabs and blocked every start).

## Sharing the tab

Everyone in the session plays the same tab, so the host sends its own to a guest that has another version (or none). While players edit together (see "Editing together") it is not sent again after every edit; for a guest that cannot edit together it is, a moment after the last edit.

- **What travels.** The open score as a Guitar Pro file (the format Smart Beat saves), cut into 8 KiB pieces and sent as base64 in `tab-chunk` frames. Gzip would shrink it, but a tab is some tens of kilobytes and the pieces fit any transport, so it is not worth the code. Over 12 MiB the host refuses to send it and says so.
- **Pace.** The host sends 12 pieces, then one more for every piece the guest has acknowledged. The guest acknowledges every fourth piece and the last. `Session.state.transfer` carries the progress for the dialog ("Getting the tab from the host…" on the guest, "Sending the tab…" on the host).
- **Checks.** The guest refuses an offer with no pieces or too many, pieces out of order or of the wrong size, and a file whose SHA-256 differs from `sha`. Then it reads the file; one that does not read is answered `tab-done` with `ok: false`. Both ends show "The tab arrived damaged" or "could not be opened" and the host does not offer the same version more than twice.
- **Where it opens.** On the guest, as a tab of its own named after the host's song and marked "(from <host>)" in the tab bar. It is not saved anywhere: closing it does not ask, and Save asks for a file. The guest's own tab stays as it was.
- **The session moves with it.** A session belongs to the workspace of one tab, so the guest's workspace hands the live connection over (`Session.release()` and `handoff.ts`) and the new tab's workspace takes it (`usePracticeTogether` with `received`). It says `hello` again as the same guest (`resume: true` and the session id); the host answers `welcome` and the clocks are measured again, which takes about a second before the first start. The connection is never closed in between, so the host does not see the guest leave.
- **Fingerprint of a received tab.** Writing a score to Guitar Pro and reading it back may change how alphaTex writes it out, so the guest keeps the host's fingerprint (`key` of the offer) for the received tab until it is edited. Without that, the two apps would never agree and the host would offer the tab again.
- **Sync tab.** The host's dialog has a **Sync tab** button that sends the tab to every guest again, with a progress bar, whatever the guests say they have. The host otherwise tries twice per version and then gives up; the button starts the count again.
- **Several tabs in one session (core).** A live session is not tied to the tab it started in. `Session.rebind(hooks)` and `HostRoom.rebind(hooks)` replace the app's hooks (prepare, schedule, position, requests, approval, tab) while the connection, the clock and the roster stay: nobody is asked again, told, or has to sync again, and guests that join later use the new hooks. A start that was being prepared or waiting for its moment with the old hooks is called off (a guest that already scheduled it is told, and a start that already happened is stopped), and a tab on its way is stopped on **both** sides: the session says `tab-abort` with `reason: "replaced"` (or `tab-done` with `ok: false` and the same reason when the tab had arrived but the app had moved on), which the other side takes as "not wanted any more", not as a failure, and the host offers again when the guest's next hello says it still has another tab. Without that, the host's sender would wait for a guest that dropped it and no later offer, Sync tab included, could go out. The host follows a rebind with `setScore` for the tab it now shows: a guest that does not have it is sent it as always; a guest that has it open already (`TabHooks.have`) answers `tab-done` with `reason: "moving"` and the app shows that tab and moves the session there (`TabHooks.show`). The host does not count the guest as having the tab until the guest's hello from the new tab says so, so a start in between is refused instead of being played with the wrong song.
- **Editing.** Everyone edits at the same time (#216): see "Editing together" below. A guest whose host is an older app, or that the host has turned editing off for, keeps a read-only copy of the host's tab (Edit is refused with a short message), and the old way applies for it: a moment after the last edit (600 ms) the host sends the new version, and only while nothing plays.
- **While the tab is on its way** the host cannot start (`command` answers `score`), because the guest would be playing something else.

## Several tabs in one session

A session is not tied to the tab it was started in. There is one live session (one connection, one clock) and it moves between the tabs of the app, so nobody has to leave and join again to play another song.

- **Adding a tab.** On the host, open another tab, then Playback › Practice Together. The first step shows **Add this tab to the session** next to starting a new one. The guests are sent that tab as a tab of its own, "Title (from Host)", over the same connection; nobody leaves or rejoins and the chip stays synchronized.
- **One plays at a time.** The tab you are looking at is the one in play. Switching to another tab of the session moves the session there: the guests show their copy of that tab, and a song that was playing is stopped for everyone (a pause command to all). The host presses Play again when ready.
- **No second copy.** A guest that already has a tab of the host's (it received it before, or opened the same file) shows it instead of receiving it again. The host sends the `tab-offer` alone and **holds the pieces back** until the guest answers it: a guest that needs the tab answers with `tab-ack` for 0 pieces, one that has it answers `tab-done` (`reason: "have"` when it is the tab it is on, `"moving"` when it has to move the session to it first) and no piece is sent. An older guest that never answers gets the pieces after 1.5 s (`OFFER_WAIT_MS`).
- **Two tabs of the same song.** Two host tabs with the same song have the same fingerprint `key`, so the key alone cannot tell them apart. The fingerprint and the `tab-offer` therefore carry an optional `origin`: the host's tab id, which a guest's copy keeps (`received.origin`). Two tabs of one song match when the keys are equal and the origins agree; a tab without an origin (one the guest opened from the same file, or an older app) matches any. The guest finds its copy with `liveTabWithKey(key, origin)` (the exact tab first, then one with the same song), receives a copy of a host tab it has none of, and a received tab is only replaced by a new version of the same host tab.
- **Received tabs stay.** The tabs a guest received stay open for as long as the session lasts, so it can follow the host back and forth (the tab in play is edited together; the others wait until the host moves to them and are then sent again); after leaving, they are ordinary tabs. The tab a guest joined with is in the session only when it has the host's song; another song of its own stays an ordinary tab (editable, playable, not counted). When the session ends on its own (the host ended it, a kick or a ban), every tab is ordinary again at once. A tab that is in the session but not the one in play does not follow the host and does not play on its own: Play, Stop and a click on a bar there are answered with "This tab is not the one in play" (`intercept` in `use-practice-together.ts`), until the host moves to it and the session goes with it.
- **Leave.** **Leave session** ends it for every tab, for the host and for each guest. Closing the tab the session is in moves it to the most recently added tab of the session and brings that tab to the front (it does not pick the tab the app would show next), and ends it when no tab of the session is left, even if other tabs are open. A song that was playing is stopped for the guests by the tab that takes over, since the closed tab could not. If the tab the session was about to move to closes first, it goes on to the next one.
- **One move at a time.** Moving the session is serialized in the whole app: a tab that asks while another move is under way waits and goes next, so the tab asked last gets it. A move that finds its tab closed or the session left in the meantime does nothing, and a failed one is not tried again until the tab is shown again; the host's **Add this tab** says so when it fails.
- **Save As on the host.** A tab of the host's is known by its id, so a new version of it with a new name (the host saved it) replaces the guest's copy; only an older host, which sends no id, is matched by the tab's name.
- **Sync tab, Rejoin, Kick and Ban** belong to the session, not to a tab, so they work the same whichever tab is in play.

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

| Preset   | Lead floor | k   | Ping | Native buffer |
| -------- | ---------- | --- | ---- | ------------- |
| Tight    | 250 ms     | 2   | 1 s  | 128 frames    |
| Balanced | 450 ms     | 3   | 2 s  | 256 frames    |
| Safe     | 900 ms     | 4   | 3 s  | 512 frames    |

**Auto** (the default) picks Tight when the error is at most 5 ms, the 95th percentile RTT at most 25 ms and the jitter at most 3 ms; Balanced up to 15 ms and 100 ms; Safe beyond. It is Balanced until 4 round trips are measured. The choice is remembered in `localStorage` (`smart-beat:practice-together:quality`). The sound is always rendered locally; the preset never changes what is streamed (nothing is).

## Starting together

`session.ts`, `shared-transport.ts`.

1. The host sends `cmd` with `at = now + leadMs` and prepares itself: the settings go into the practice state, and a `play` or `seek` moves to the tick.
2. The guest converts `at` to its own clock and prepares (it refuses with `ready: false` when less than 20 ms is left). It answers `ready`.
3. If both are ready 30 ms before `at`, both start: a timer, then a tight loop for the last 12 ms. Each fires early by its own output latency, so the sound is heard at the same moment. If either is not ready, the host sends `abort` and nobody starts; the group is told.
4. A count-in is part of the schedule: `at` is when the count-in begins.

The host's speed, loop, metronome and count-in follow with a `settings` command whenever they change. A guest's Speed Trainer is ended (the host runs it and its speeds are sent).

## After the start: nothing is corrected

Both computers run the same score at the same speed from the same instant, so once playing they stay together. The clocks are measured before every start (and the pings go on, so the estimate is fresh for the next one), but **nothing is re-synchronised or corrected while the song plays**: no speed change, no jump. An early version nudged the speed by up to ±5 % whenever the guest's measured position differed from the host's. That measurement is only as exact as the synthesizer's position reports (they come in chunks, and are off while the host's CPU is busy with audible tracks), so a single bad reading made the guest speed up or slow down for seconds and the two slid 1 to 2 seconds apart. Pause or Stop, then Play, starts both again from the same instant.

The host still reports its position every second (`state`) and the guest compares it with its own, taking the age of the report into account and taking the median of the last 5 readings (at least 3). That number is only **shown** (Drift in the dialog, and the `report` the host shows); it changes nothing.

Because nobody may move the position while the song plays, a click on a bar is refused during playback (the score ignores it and a message says to pause or stop first), for the host and the guest alike. While stopped or paused, a bar can be picked: the host's pick is shared with the guest, and a guest's pick is sent to the host as a `request` that the host shares.

### Who may press what

Both players can press Play, Pause and Stop. A guest's press is a `request`; the host decides whether it makes sense now (Play when it is already playing, Pause when it is not, and a position while playing are ignored) and then sends the usual command with a start time ahead, so both still start at the same instant. The host's own buttons work the same way. The host decides the settings (speed, loop, metronome, count-in) and its position is the one that counts.

### Sound engine, metronome and count-in

A session always plays the notes with the SoundFonts (alphaTab's synthesizer). The native engine has its own clock and audio buffers and cannot be started at an agreed instant for the notes, so when the app is set to the native engine it is switched to the SoundFonts for the session and switched back when the session ends (the saved choice is not changed). The audio lanes play in the native engine next to the SoundFonts (see "Audio lanes together"), started on the engine's clock at the same instant.

The metronome and the count-in are played with Web Audio (the count-in always, the metronome in every sound but the classic click). A browser only lets a page make sound after a click or a key press, and the guest's page is started by a network message that nobody clicked, so the first count-in clicks on the guest were silent or late. The click that hosts or joins a session now opens the click audio and the synthesizer's output (`ScorePlayer.warmUpAudio`), and measures the output latency, which the first start needs to be moved earlier by. A start that cannot play because the song is not loaded yet is reported as "not ready", so nobody starts alone.

## When something goes wrong

| Case                           | What happens                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Different version of the score | Refused at joining; changing the score later shows a warning and the host cannot start                                                                                                                                                           |
| Connection drops               | A guest: "Reconnecting…" for 20 s; it says hello again with its session id and the clocks are measured again; after 20 s the session ends and the dialog offers **Rejoin**. A host keeps the guest's place for 10 minutes and the others play on |
| Computer sleeps                | The clock is measured again; a message says so                                                                                                                                                                                                   |
| A player is not ready in time  | The start is called off for both and a message says so                                                                                                                                                                                           |
| Quality too poor               | A warning in the dialog, the chip and a toast                                                                                                                                                                                                    |
| Other app too old or too new   | Refused with `version`                                                                                                                                                                                                                           |
| Guest leaves                   | Its place is freed and the host sees "<name> left the session." for a few seconds; the others play on                                                                                                                                            |
| Session full                   | The tenth guest is told "The session is full" and turned away                                                                                                                                                                                    |
| Kicked or banned               | "The host removed you…" (can join again) or "The host blocked you from this session." (cannot)                                                                                                                                                   |
| Host leaves                    | The session ends for the guest                                                                                                                                                                                                                   |

## Privacy

- The tab, the lanes, the audio files and the playback never go through any server. In a session they travel only between the two computers. The meeting service sees only setup messages.
- The anonymous usage counters ([`analytics.md`](analytics.md)) count only that things happen (a session hosted or joined, how well the clocks agreed, how it ended, a length range). Room codes, tokens, addresses, player names, song titles and tab contents are never part of them, and the details are fixed words, so nothing typed can be sent.
- **Same network:** nothing leaves your network. The host's local address is inside the code.
- **Over the internet:** the app contacts the signaling Worker (to make or join a room) and `stun.cloudflare.com` (to learn its public address). The other player can then see that address in the WebRTC connection. This is said in the dialog. The room is deleted after 10 minutes.
- The user's name is typed in the dialog and shown to the other player only.

## A direct connection without a router

On the Choose step, "Same network" has a link, "Need a direct connection? (no router, cable or hotspot)". It opens a help view with the steps of the computer's own system only (`detectDesktopOs()` in `src/lib/practice-together/desktop-os.ts` reads `navigator.userAgentData`, `platform` and `userAgent`; the text is in `direct-connection.ts`):

- **macOS:** Smart Beat cannot switch Wi-Fi sharing on (there is no supported way for an app to), so the help offers a cable, a phone's hotspot, and Internet Sharing in System Settings.
- **Windows:** Settings › Network & internet › Mobile hotspot, then the other player joins it. A cable and a phone's hotspot are listed as well.
- **Linux:** Turn On Wi-Fi Hotspot (GNOME) or `nmcli device wifi hotspot`, then the other player joins it.
- **Anything else** (phones, Chromebooks, unknown systems): only the cable and phone-hotspot tips.

Every system also gets what to expect (a computer that makes the network usually loses its normal Wi-Fi internet, so "Over the internet" will not work meanwhile; accuracy is typically ±1–5 ms and a cable is the steadiest) and how to check (after both are on the same network, the host starts a session again and the other player types the new code). The steps are written without version numbers and were not tried on every system version.

## Permissions of the operating system

- **macOS:** the first connection triggers the Local Network prompt. The text comes from `NSLocalNetworkUsageDescription` in `src-tauri/Info.plist`. If it was refused, allow Smart Beat in System Settings › Privacy & Security › Local Network.
- **Windows:** Windows Defender Firewall asks once when the host starts listening. Allow private networks.
- **Linux:** a firewall may block incoming connections to the host's port; the dialog shows the address that is listened on. WebRTC (Over the internet) needs a WebKitGTK built with it; the option is hidden where `RTCPeerConnection` is missing.

## Setting up the signaling Worker (once)

Only "Over the internet" needs it; without it the app offers the same network only.

1. Add the repository secrets `CLOUDFLARE_API_TOKEN_SIGNALING` (a token of its own, with only _Workers Scripts: Edit_, so it is separate from the analytics Worker's `CLOUDFLARE_API_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID` (shared).
2. Merge a change under `signaling/` to `main`. [`signaling-deploy.yml`](../.github/workflows/signaling-deploy.yml) tests it and runs `wrangler deploy`. Without the secrets the deploy job is skipped with a warning.
3. Set the repository **variable** `SIGNALING_URL` (Settings › Secrets and variables › Actions › Variables) to the Worker's address, for example `https://smart-beat-signaling.<account>.workers.dev`, without a trailing path. `release.yml` bakes it into release builds as `SMART_BEAT_SIGNALING_URL`. Without it, and in pull requests, the build has no address and the option is not offered.

Locally: `pnpm --dir signaling dev` runs the Worker; build the app with `SMART_BEAT_SIGNALING_URL=http://127.0.0.1:8787` set (in the shell or in the git-ignored `.env`, see `.env.example`) to try it. The deployed Worker is `https://smart-beat-signaling.smart-beat.workers.dev`. Tests: `pnpm --dir signaling test`.

## Measured error

What is measured so far (automated, one computer):

- Rust link on loopback: the best of 20 round trips of a frame is under 20 ms (`src-tauri/tests/practice.rs`); typically well below 1 ms.
- Two simulated players with a 10 ms wire each way and clocks 7 s apart start within 3 ms of each other, on the host's clock (`shared-transport.test.ts`). The clock estimate finds a steady offset to within the test's resolution and follows a 200 ppm skew.

Not measured yet, and to be written here after the checks in [manual-checks.md](manual-checks.md):

- The start error of two real computers on the same Wi-Fi and on a cable (target: a few milliseconds plus the difference of the two output latencies).
- A 10 minute session without audible drift.
- Over the internet, and on Windows or Linux as the second system.

Limits:

- alphaSynth reports its position in chunks, so the drift shown has a resolution of roughly a tenth of a second; the median of five readings absorbs it.
- alphaSynth has no scheduled start and a 500 ms buffer; its start error is the timer's (a millisecond or two) plus how well the output latency is known. Set the sync offset in the Inspector ([manual-checks.md](manual-checks.md), check 1) on both computers.
- WebRTC in WebKitGTK is unverified.
- No TURN relay: two computers behind strict firewalls cannot connect over the internet.
- Audio is never streamed: the files of the lanes are copied once. No public matchmaking (that stays in #94).

## Audio lanes together

Everyone hears the same lanes. A tab's audio lanes (clips on lanes, from Record audio, from a file or from Export stems) are shared along with the tab (#239):

- **Shared:** the lanes (name, colour, folder and group, pitch, order), their clips, the files the clips play, the song's sync points, markers and regions. **Personal:** each player's lane volume, pan, mute, solo, EQ, filter, effects, sends and automation, whether a lane is on, and how it is shown (collapsed, height, shown under the score), plus the buses, the ripple mode and the play zone. A hostile or broken message cannot change a personal field: operations name shared fields only.
- **How.** Lane edits are found by comparing the shared parts of the lanes before and after an edit (`lib/audio-lanes/collab.ts`: `diffAudio`) and travel as operations that name a lane, clip or file by its id and set it to a value (`a-lane-add`, `a-lane-set`, `a-clip-set`, `a-clip-del`, `a-src-add`, `a-sync-set`, `a-mark-set`, and so on). They use the editing channel of the tab: the host numbers them (`seq`), keeps them in the same log, and sends them to every guest that says `lanes` in its capabilities; an older app gets the tab's edits only. Operations are absolute, so applying one twice, or after someone else changed something else, is harmless. A burst of changes (a drag) is sent as one batch 80 ms after the last change. Another player's batch is checked (shapes, ids, sizes, ranges, at most 16 lanes, 2000 clips on a lane, 512 files) before it touches anything, then applied without an undo step of its own, and a refused batch makes the host send the guest the tab again.
- **Joining and coming back.** A guest that joins gets the lanes as they are (`a-reset` followed by every shared part) before the edits since the tab file, and goes live. Its own lanes of the same file keep this player's mix of a lane both have; everything else is the host's.
- **Undo and redo** in a session take back only your own edit, as a patch on what the lanes are now, so a lane another player added stays.
- **Rights.** A guest the host has not allowed to edit (or one that is not up to date) cannot edit the lanes either; it only receives them.
- **Audio files** travel once each, by the SHA-256 of their bytes (the id clips use), and never as part of the tab (`lib/practice-together/source-transfer.ts`, messages `src-have`, `src-want`, `src-offer`, `src-ack`, `src-chunk`, `src-done`). Each player says which files it has; a player that lacks one asks a player that has it. A guest only talks to the host: a file a guest adds goes to the host first and the host hands it on, so every file moves once per receiver. Pieces are 10 KiB (under a frame), at most 16 are on the way before the receiver has said where it is, the receiver writes them into a file in the temporary folder (never holding a file in the page), checks the SHA-256 against the id when it is complete, and loads it. A transfer that stops starts again where it stopped; a lost piece is asked for again. The files wait while the song plays, so the timing comes first. Limits: 512 MiB a file, 512 files, 2 GiB moved to each player per session (a file sent again to the same player is not counted twice, and a player over its quota is told so, not that nobody has the file), two files taken in at a time, and 3 GiB of decoded audio taken in per session (a few tiny, highly compressed files decode to a lot, so the decoded size is counted on its own; Rust also refuses to decode another file of another player while the app holds more than that). Unfinished files wait in a private folder with a random name in the temporary folder. A file that nobody has any more, or that a player could not take in, is reported on the host ("Couldn't share Drums: …"), so Play's message says what to do.
- **Nobody starts until everyone has every file.** The host holds Play back (a message names the files still on the way, and a file that could not be sent says why), a guest's own Play is held back the same way, and a start that reaches a computer that lacks a file is refused (`SharedTransport.prepare`). Progress is in the session dialog ("Sending Drums · HTDemucs… 45 %") and the chip ("Files 45 %").
- **Playback.** A session plays the notes with the SoundFonts and the lanes with the native engine's lanes engine (hybrid playback, ADR 0003). The start waits until the lanes engine has the song, and both engines start from the same call at the agreed instant; the lanes follow the notes (the start is moved by the difference of the two output latencies).

## Editing together

Everyone in the session can edit the tab in play at the same time. A change shows on the other computers within a moment.

**How it works.** The editor describes every edit as _operations_ (`src/lib/score/ops`): insert, delete or set something, addressed by a stable id of the track, bar line, bar, voice, beat or note (not by position, which moves when a bar is inserted). Two players who open the same file derive the same ids from it; parts made later get a player's own ids, and a player that gets the tab as a file is told the ids that differ (`uids`). The operations are found by comparing the bars an edit touched before and after it (`ops/diff.ts`), so every editor command works without being rewritten; an edit that cannot be described this way (tracks and bar lines changed together, reordered parts) makes the host send the whole tab again (`reset`).

**Merging.** A guest sends its operations to the host (`edit` messages, `ops`). The host applies them, numbers them (`seq`) and sends them to every guest, the sender included. Everybody applies the operations in the host's order, so all computers end with the same tab: operations set absolute values (the host's order decides when two players change the same value), deleting twice is harmless, an edit to something another player deleted is dropped, and an insert whose neighbour is gone goes to the end. A guest applies its own edit at once; when its echo comes back after another player's edit it is applied again, which puts the shared order in place. Edits happen at the granularity of notes, so two players changing different notes of one beat both keep their change. If two players delete the last two bars at the same time, an empty bar stays. The host's tab is only sent again when a guest joins or asks (`resync`), when Sync tab is pressed, or when the copies differ for six seconds (at most three times: how two apps write the same music can differ without any edit being lost).

**Joining and coming back.** The host numbers the tab file when it writes it (`tab-offer.seq`). A guest that opened it says `since`; the host answers with the ids that differ, the edits since (from a log of the last 400), and `live`. A guest that was away says the last edit it saw (`since` with `resume`) and gets what it missed; its own edits that were never echoed are sent again. If the log no longer reaches back, the tab is sent again.

**Undo and redo.** While a session is live, Undo and Redo use a history of the player's own edits (`ops/collab.ts`): the operations that take an edit back are made with the edit, so Undo takes back your edit and leaves the other players' alone. An edit that cannot be taken back this way (for example removing a track) clears that history. Outside a session the ordinary history is used.

**Cursors.** Each player sends where their cursor and selection are (`presence`, at most ten times a second) as ids of a track and beats, so a cursor stays on its beat when bars are inserted before it, and shows as a coloured outline with the player's name on every other computer. The player's colour comes from their id.

**Rights.** The host decides (Guests can edit the tab, on by default). The host ignores edits from a guest that may not edit or is not up to date, and from one that was removed: a kicked or banned guest has no seat any more. A guest that may not edit sees the tab as before: it follows the host's tab and Edit is refused with a message. The host's metronome, count-in, speed and loop stay the host's (the guest's practice settings are locked as before).

**Playback.** Edits from other players go through the same path as the player's own: the sound is rebuilt after playback stops (the player already defers it), and nothing touches the shared clock, the position or the practice settings. Messages are split to fit a frame (16 K characters); a big paste is cut into small operations first.

**Limits.** Live editing is for the tab in play. Other tabs in the session are sent when the host moves to them. Moving or reordering tracks, and an edit that changes tracks and bar lines at once, send the whole tab again. Two players who set the same value at the same moment: the host's order wins, so one of the two changes is replaced. Some edits change other bars as a side effect (deleting the first bar moves the instrument change to the next one); in a long run of random edits by three players, a few in a hundred ended with a difference of that kind. The check for copies that differ for six seconds sends the tab again then (at most three times).
