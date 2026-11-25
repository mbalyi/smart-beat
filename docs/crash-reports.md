# Crash reports (on by default, easy to switch off)

Smart Beat can send a report when it crashes or fails with an unexpected error, so bugs that only happen on other people's computers can be found and fixed. It is **on by default** in a build that has the report addresses (see below), and the user can turn it off at any time in **Help › Settings › Send crash reports**; turning it off stops sending at once and the choice is kept for every later version. A build without the addresses (a local or pull request build) never sends anything.

This is separate from the anonymous usage counters ([`analytics.md`](analytics.md)): each has its own switch, and one does not need the other. Because it is on unless switched off, an update that brings it announces it in the release notes and in What's new, and the Settings wording says it is on. The counters only count that something failed (a fixed category); a crash report is the technical trace of one failure.

## What is sent

Errors only: one event per crash or unexpected error, reduced to this and nothing else:

- the **exception type** (for example `TypeError`, or `panic` for the Rust core),
- the **stack frames**: function name, the app-relative file (`src/...`, `src-tauri/src/...`, or the name of the built script such as `index-AbC123.js`), line and column,
- the **release** (the app version), the **environment** (`production` or `development`) and the **operating system** family (`macos`, `windows` or `linux`, in the tag `os`).

Both halves of the app report, each to its own Sentry project: the UI (JavaScript, `@sentry/browser`) and the core (Rust, the `sentry` crate). The same rules apply to both, and each half scrubs the event on the device before it is handed to the network code.

## What is never sent

- **No Session Replay, no video or screen capture, no screenshots.** None of these integrations is installed or configured, not even switched off or at a sample rate of 0. Smart Beat never records what you see or hear.
- **No tracing or performance data, no logs, no profiling, no breadcrumbs, no attachments, no user-feedback widget.**
- No songs, tab contents, notes, audio or stems, and no file names, folder names or paths (`/Users/jane/...`, `C:\Users\jane\...`).
- No exception message and no event message (they can contain file names or typed text), no local variables.
- No user name, e-mail address, IP address, host name, machine id, user id or install id. `sendDefaultPii` / `send_default_pii` is off and the server name is left empty.
- No URLs and no tokens: `https://...?token=...`, `file:///...`, `tauri://localhost/...`, any run of 24 or more letters and digits, and IPv4 addresses are removed.
- No request data, no contexts (device, browser, OS version), no extra data, no other tags, no module list.

A frame whose location cannot be reduced to the forms above is dropped, and an event that has no frame left is dropped completely. Whatever the scrubber does not know is dropped, not kept: it is an allow-list.

Unit tests cover these cases in both halves (the UI scrubber in `src/lib/crash-scrub.ts`, the Rust one in `src-tauri/src/crash_scrub.rs`), and fail if a replay, feedback, tracing or logs integration is ever configured.

## An example event

What leaves the device for a failure in the UI (the Rust half sends the same fields):

```json
{
  "exception": {
    "values": [
      {
        "type": "TypeError",
        "stacktrace": {
          "frames": [
            {
              "function": "applyEdit",
              "filename": "src/lib/score-edit.ts",
              "lineno": 212,
              "colno": 18
            },
            { "function": "onKeyDown", "filename": "index-AbC123.js", "lineno": 1, "colno": 48211 }
          ]
        }
      }
    ]
  },
  "release": "1.3.0",
  "environment": "production",
  "tags": { "os": "macos" },
  "server_name": ""
}
```

In a release build the functions and lines of minified code are often not readable (see [Readable stack traces](release.md#readable-stack-traces-optional)); that is why the app version is part of every event.

## Turning it on and off

- **Settings › Send crash reports** is the only switch. The wording there says what is sent and that no replay, screen recording or screenshots are ever made.
- **On** (the default, when the player never chose): the Rust client starts at launch and, when the build has the UI address, the UI client starts too. Nothing is saved to disk until the player makes a choice.
- **Off**: no client exists. Nothing is initialised and no request is made to Sentry. This choice is saved and always wins, also after an update.
- **Turning it off** closes both clients immediately. Events that were still queued are discarded, not sent later.
- **Turning it on again** starts the Rust client and, when the build has the UI address, the UI client, without a restart.
- A saved choice that cannot be read (a damaged file) counts as **off**: a damaged choice never turns reports on.
- A build without an address is a complete no-op for that half, whatever the switch says. The switch is only offered when the core address is part of the build (`available` in `get_crash_report_settings`).

The choice is stored by the Rust core in `crash-reports.json` next to the usage settings (`get_crash_report_settings` / `set_crash_report_settings`). They are not counted as errors, like `get_usage_settings`.

## How the build gets the addresses

The addresses (Sentry DSNs) are build-time values. They are never in the repository.

| Half            | Variable                         | Read as                                                       | Sentry project |
| --------------- | -------------------------------- | ------------------------------------------------------------- | -------------- |
| UI (JavaScript) | `SMART_BEAT_SENTRY_DSN_FRONTEND` | `import.meta.env.VITE_SENTRY_DSN_FRONTEND` (`vite.config.ts`) | frontend       |
| Core (Rust)     | `SMART_BEAT_SENTRY_DSN_CORE`     | `option_env!("SMART_BEAT_SENTRY_DSN_CORE")`                   | core           |

- **Local builds** read them from the git-ignored `.env` ([`.env.example`](../.env.example)), also from the main checkout's `.env` in a git worktree, like the cloud sign-in keys. Real environment variables win. Rebuild after editing.
- **The release pipeline** passes the repository **secrets** of the same names ([`release.yml`](../.github/workflows/release.yml), [`release.md`](release.md#crash-report-addresses)). Pull requests and forks have none, so those builds contain no address and the integration is a no-op.
- **Without a value** that half does nothing: no client, no request, no error.

The content security policy lets the webview connect to one more host for this: `https://*.ingest.de.sentry.io` in `connect-src` of [`tauri.conf.json`](../src-tauri/tauri.conf.json). That is the EU ingest host of Sentry; the webview can reach no other Sentry address. Events of the Rust half are sent by the core and need no CSP entry.

## How to check it

1. **On by default, only with an address.** Start a fresh build that has the addresses: Settings shows the switch on. A build without them (a local build) shows "This version of Smart Beat does not send crash reports" and makes no request to any `sentry.io` host.
2. **Nothing after switching off.** Turn the switch off: no request follows, also not for something that failed in between, and it stays off after a restart and after an update.
3. **Only a scrubbed event.** With the switch on, cause a harmless test error from app code in a development build (for example a temporary `throw new TypeError("x")` in a button handler; an error typed into the web inspector's console has no frame inside the app, so the scrubber drops it on purpose). One request goes to `https://<key>@o<number>.ingest.de.sentry.io`; its body has only the fields of the example above. Look for a path, a user name or a file name in it: there must be none.
4. **Automated.** `pnpm test` runs the scrub and gating tests, `pnpm test:e2e` checks that no request to a Sentry host is made while the switch is off and that only a scrubbed event is sent when it is on, and `cargo test` in `src-tauri/` runs the Rust scrubber tests.
