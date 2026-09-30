---
name: install-mac-app
description: Build the Smart Beat macOS bundle and install it into /Applications so the user can test by hand. Use when asked to install/rebuild/reinstall the app on the laptop.
---

Reply in English.

1. Build in the background (LTO makes it take minutes) and keep working meanwhile:
   ```bash
   source ~/.cargo/env && pnpm tauri build
   ```
   Use `run_in_background`; do not poll in a loop, wait for the completion notification.
   Note: heavy builds starve timing-sensitive tests, so re-run any test that fails only while the build runs.
2. When done, quit the running app if open (`osascript -e 'quit app "Smart Beat"'`), then replace `/Applications/Smart Beat.app` with the new bundle from `src-tauri/target/release/bundle/macos/` (or the universal target dir if built that way).
3. Verify: `codesign --verify --deep --strict "/Applications/Smart Beat.app"`, then launch it with `open` and confirm the process starts.
4. Tell the user which commit/branch the installed build contains, and which later fixes it lacks if any.
