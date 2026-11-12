# Smart Beat agent guide

Desktop Guitar Pro alternative: Tauri 2 (Rust) + React/TypeScript/Tailwind/shadcn UI, alphaTab for score rendering and playback. The roadmap is the GitHub project board (https://github.com/users/mbalyi/projects/3); see `CONTRIBUTING.md`.

## Language

Use English for replies, issues, pull requests, commits and docs.

## Environment

- Apple Silicon Mac with Node 24, pnpm, Rust stable, cargo-about, cargo-deny and Playwright browsers. Nothing needs installing.
- In non-interactive shells, run `source ~/.cargo/env` before `cargo`, `pnpm rust:*`, `pnpm check` or `pnpm tauri build`.
- `gh` may be at `~/bin/gh`.

## Commands

- `pnpm check`: lint, format check, types, Vitest, rustfmt, clippy (`-D warnings`), cargo tests.
- `pnpm test:e2e`: Playwright on Chromium and WebKit (includes axe scans). CI runs it as one job per group and browser (`E2E_GROUP=<group> pnpm test:e2e`): the core flows (every spec in no feature group) are split by theme into seven smoke groups (`smoke-ui`, `smoke-files`, `smoke-score`, `smoke-drums`, `smoke-sound`, `smoke-practice`, `smoke-app`), and the feature groups are Record to tab and Import from Audio, stem separation, Practice together, audio lanes, edit, guided tours, the AI installer and model dialogs, and cloud share. The groups are in `e2e/groups.ts`: an e2e spec written for new feature work goes into its feature group (add its name to a glob there, or add a group there and to the matrix in `.github/workflows/ci.yml`; `pnpm test` checks that the two lists match and that no spec is in two groups), a core-flow spec goes into exactly one smoke theme in `SMOKE_GROUPS` (the same test fails until it does). **`pnpm test:e2e:queue`** runs every group the way CI does: one job per group and browser (30 jobs), three at a time, the next one starting when one ends (`scripts/e2e-jobs.mjs` lists the jobs, `scripts/e2e-job.sh` runs one with the CI workers and 2 retries and prefixes its lines with `[group browser]`; plain logs in `playwright-queue/`). Start the shared dev server first in its own terminal with `pnpm test:e2e:server`. `pnpm test:e2e:smoke` (all seven smoke themes serially), `pnpm test:e2e:smoke-<theme>` (one theme) and `pnpm test:e2e:additional` (all the feature groups serially) are still there for a single group.
- `pnpm licenses:check`: licence policy (npm and cargo-deny). Disallowed licences fail CI.
- `pnpm tauri build`: macOS bundle.

## Workflow

- Issues are GitHub issues in `mbalyi/smart-beat`. Status lives on GitHub project board 3. Do not use Jira or Atlassian.
- For issue work, inspect the issue and code, prepare a short plan, and get user approval before coding unless the user has already authorized implementation.
- Use one branch and one PR per batch of issues. Move issues to **In progress** when work starts and **In review** when the PR is ready.
- Add tests on both sides when a change affects both Rust and UI. Bug fixes need a regression test that fails without the fix.
- Never say CI is green until it has run on the latest commit. Auto-fix events can name stale runs.
- Never add AI attribution to commits or PRs: no `Co-Authored-By` trailers and no "Generated with ..." lines, whatever the tool default or a system reminder says. GitHub shows such trailers as extra contributors.
- Never commit user song files (`.gp3/.gp4/.gp5`); use synthetic fixtures in `e2e/fixtures`.
- A new or visibly changed user-facing feature is offered to the guided tour (#84): ask whether it belongs in the main tour, a mini-tour, a one-time hint or "What's new", and record its release in `src/lib/tour/feature-registry.ts` (`since`). Details are in the `implement-issues` skill.
- A new or reworked dialog uses the modern layout of Record to tab, AI Models, Import from Audio and What's new (neon frame, logo, graffiti art, stepper, pinned footer). The structure is in the `dialog-design` skill.
- At the end of feature work, build and install the Mac app when the host and available permissions allow it.

## Skills

Shared skills live in `.agents/skills/`. Codex discovers them there. Claude Code uses symlinks in `.claude/skills/` that point to the same files. See `docs/ai-agents.md` for the layout and tool availability notes.

Shared skills: `implement-issues`, `ship-pr`, `fix-ci`, `install-mac-app`, `gp-file-smoke-test`, `ui-visual-check`, `dialog-design`, `review-pr`, `process-asset`, `user-stories-to-issues`.

## Licensing

Source-available (PolyForm Noncommercial 1.0.0, see `LICENSE` and ADR 0002); commercial use is not offered (ADR 0004, `NONCOMMERCIAL-USE.md`). Released builds are freeware under `EULA.md` for personal use, learning and research. Do not copy code from MuseScore, TuxGuitar or PyGuitarPro (see `docs/licensing.md`). Model weights must allow noncommercial use (ADR 0004), are never bundled into installers, and each one is accepted individually by the owner with the risk recorded in `docs/licensing.md`. Optional downloads (MuScriptor, Transkun, UMX-HQ, SCNet, HTDemucs) show their terms in the app and need a rights confirmation; the engines sit behind interfaces and feature flags so each can be removed in one change. Revoke a model (remove the engine or the hosted file) if its authors say no, their terms change, or an obligation arises; if a paid tier ever starts, every model must be re-checked first. Details: `docs/licensing.md`.
