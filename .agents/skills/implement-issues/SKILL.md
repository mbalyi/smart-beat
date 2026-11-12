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
6. **Verify**: `source ~/.cargo/env && pnpm check` and `pnpm licenses:check`, then the Playwright e2e tests locally **the way CI runs them**: one job per group and browser (30 jobs, from `e2e/groups.ts`), as an event queue that keeps **three jobs running** and starts the next one as soon as one ends. Use the Terminal panel, so the user can watch it live:
   1. `run_in_terminal` with `pnpm test:e2e:server` (the shared Vite dev server; three jobs starting their own would race for the port). Leave it running until the queue ends.
   2. `run_in_terminal` with `pnpm test:e2e:queue` in a second tab (`node scripts/e2e-jobs.mjs | xargs -P 3 -L 1 scripts/e2e-job.sh`: the job list, and one small script per job). Every line is shown with `[group browser]` in front; the plain log of each job is `playwright-queue/<group>-<browser>.log`. A job runs with the workers CI gives its group and 2 retries, as on CI; a test that passes only on a retry is flaky, which is not green.
   3. Watch it until it ends: a `Monitor` on `tail -F playwright-queue/*.log | grep --line-buffered -E "✘|failed|flaky|finished, exit"` (and `read_terminal` on the queue tab). Do not stop the queue or start another way of running the tests while it runs: wait for the end. Do not poll in a loop.
   4. Report per group and browser (the `finished, exit` lines and the passed, failed and flaky counts at the end of each log). Fix every failing or flaky job: read its log, re-run one failing spec with `pnpm exec playwright test e2e/<file>.spec.ts`, and one job again with `scripts/e2e-job.sh <group> <browser> <workers>`. A test that passes alone but fails in the queue is a load problem: find the cause (the CI report artifact has the trace), fix it with a test that fails without the fix, and say so in the PR. Run the whole queue again at the end until it is green.
      A new group goes into the CI matrix and `e2e/groups.ts` (`pnpm test` checks that they match and that `scripts/e2e-jobs.mjs` lists it).
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
