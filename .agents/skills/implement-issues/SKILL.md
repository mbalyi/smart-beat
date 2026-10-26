---
name: implement-issues
description: Implement one or more Smart Beat GitHub issues end to end (plan, board status, one branch, one PR, Rust and UI tests, install the Mac app). Use for "implement issues 11-13" or similar.
---

Implement the issue numbers or range provided by the user from mbalyi/smart-beat. Reply in English.

1. **Sync**: `git fetch` and start from the latest `origin/main` (use a worktree branch if one is not already set up).
2. **Read** each issue with `gh issue view <n>` and the relevant code. Do not open Jira or Atlassian; status lives only on GitHub project board 3.
3. **Plan first**: write a short plan (per issue: approach, files, tests, open questions) and get the user's approval before coding, unless the user has already authorized implementation. Ask only about decisions that are truly the user's.
   - **Onboarding tour**: for every issue that adds or visibly changes a user-facing feature, ask the user (AskUserQuestion) whether it belongs in the guided tour: the main tour, a mini-tour (editing, Speed Trainer, effects, Record to tab), a one-time hint, and/or the "What's new" list. Record the answer in the plan. If yes, implement it with the feature: an entry in `src/lib/tour/feature-registry.ts` with `since` set to the release it ships in (the next version after `package.json`), `data-tour` targets on the controls, steps in `src/lib/tour/tours.ts`, and tests. If no, say why in the PR. Bug fixes and internal changes need no question.
4. **Board**: move every issue to **In progress** on project 3 (see the `gh project` commands below).
5. **Implement** on one branch for all issues. A new or reworked dialog follows the `dialog-design` skill (modern layout, not a plain form). Add tests on both sides:
   - UI: Vitest unit/integration and Playwright e2e (Chromium and WebKit), including axe accessibility scans in light and dark mode for new screens.
   - Rust: unit tests plus `src-tauri/tests` integration tests.
   - Every bug found while testing gets a regression test that fails without the fix.
6. **Verify**: `source ~/.cargo/env && pnpm check`, `pnpm test:e2e`, `pnpm licenses:check`.
7. **Ship**: follow the `ship-pr` skill (one PR that closes all issues; move issues to **In review**).
8. **Install**: follow the `install-mac-app` skill. Start it in the background as soon as verification passes, so PR work continues in parallel.
9. **Report**: what was built per issue, test counts, limitations, anything needing the user's attention. No claims about CI until it has run on the latest commit.

If GitHub project permissions or an integration needed for a step are unavailable, continue with the local work and report that step as pending. See `docs/ai-agents.md` for tool fallbacks.

## Board commands

```bash
gh project field-list 3 --owner mbalyi            # find the Status field and option ids
gh project item-list 3 --owner mbalyi --format json
gh project item-edit --project-id <PVT_id> --id <item_id> --field-id <status_field_id> --single-select-option-id <option_id>
```
