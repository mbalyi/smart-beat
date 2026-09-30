---
name: gp-file-smoke-test
description: Manually exercise Smart Beat against a real Guitar Pro file (open, edit, copy, play, undo) to find bugs that fixtures miss.
argument-hint: [path to .gp3/.gp4/.gp5 file]
---

Reply in English.

1. Use the file given in `$ARGUMENTS`; otherwise look in `~/Downloads` for `*.gp3`, `*.gp4`, `*.gp5` and tell the user which one you chose.
2. Start the app in the browser pane (`preview_start`) and load the file through the app's open flow.
3. Exercise: render, play/pause/seek, speed and loop, mixer, track add/remove/duplicate, note entry, undo/redo, copy/paste beats, fretboard/keyboard view.
4. Note every console error and visual glitch (`read_console_messages`, screenshots).
5. For each bug: reproduce, fix, add a regression test (unit and/or Playwright), and list it in the final report.
6. Never commit the file. Do not copy it into the repo; small synthetic fixtures live in `e2e/fixtures` (see `scripts/make-fixtures.mjs`).
