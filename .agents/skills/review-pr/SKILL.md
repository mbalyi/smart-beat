---
name: review-pr
description: Review a Smart Beat pull request and, when there are no findings, approve it. Use for "review PR 123" or "review this PR".
---

Review the pull request named by the user (number or link in mbalyi/smart-beat). Reply in English.

1. **Read** the PR with `gh pr view <n>` and `gh pr diff <n>`, plus the linked issues. Check out the branch if you need to run anything.
2. **Review** for correctness bugs, regressions, missing tests (a bug fix needs a regression test that fails without the fix), accessibility of new UI, and that it follows `AGENTS.md`. New or reworked dialogs must follow the `dialog-design` skill. User-facing features need their README, CHANGELOG and What's new entries.
3. **Verify** what you can locally (`source ~/.cargo/env && pnpm check`, the relevant tests) and say what you could not run. Never claim CI passed unless it has run on the latest commit.
4. **Decide**:
   - **Findings**: list them, most severe first, each with file and line, the failing scenario and a suggested fix. Post them as review comments (`gh pr review <n> --request-changes` or `--comment`). Do not approve.
   - **No findings**: approve the PR with `gh pr review <n> --approve --body "<one or two lines on what you checked>"`.
5. **Report** to the user: the verdict, what was checked and what was not.

Approving is public and cannot be silently undone, so approve only when step 2 and 3 found nothing. GitHub does not let an author approve their own PR: if the PR is the user's own, say so and give the verdict in the reply instead.
