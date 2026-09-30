# Smart Beat

Desktop Guitar Pro alternative: Tauri 2 (Rust) + React/TypeScript/Tailwind/shadcn UI, alphaTab for score rendering and playback. See `high-level-plan.md` for the roadmap and `CONTRIBUTING.md`.

## Language
Always reply in English, even when the user writes in another language. Issues, PRs, commits and docs are English.

## Environment
- Apple Silicon Mac with Node 24, pnpm, Rust stable, cargo-about, cargo-deny, Playwright browsers. Nothing needs installing.
- In non-interactive shells run `source ~/.cargo/env` before `cargo`, `pnpm rust:*`, `pnpm check`, `pnpm tauri build`.
- `gh` may be at `~/bin/gh`.

## Commands
- `pnpm check`: lint, format check, types, Vitest, rustfmt, clippy (`-D warnings`), cargo tests.
- `pnpm test:e2e`: Playwright on Chromium and WebKit (includes axe scans).
- `pnpm licenses:check`: licence policy (npm and cargo-deny). Disallowed licences fail CI.
- `pnpm tauri build`: macOS bundle.

## Workflow
- Issues are GitHub issues in mbalyi/smart-beat. Status lives only on GitHub project board 3. Never open Jira or Atlassian.
- Plan first and get approval, move issues to In progress, one branch and one PR per batch of issues, then In review.
- Add tests on both sides (Rust and UI). Bug fixes need a regression test that fails without the fix.
- Never say CI is green until it has run on the latest commit; Auto-fix events can name stale runs.
- Never commit user song files (`.gp3/.gp4/.gp5`); use synthetic fixtures in `e2e/fixtures`.
- If the shell permission check keeps failing, use the Terminal panel.
- At the end of feature work, build and install the Mac app.

## Skills (`.claude/skills`)
`implement-issues`, `ship-pr`, `fix-ci`, `install-mac-app`, `gp-file-smoke-test`, `ui-visual-check`, `process-asset`, `user-stories-to-issues`.

## Licensing
Proprietary freeware. Do not copy code from MuseScore, TuxGuitar or PyGuitarPro (see `docs/`). Do not add models with non-commercial licences.
