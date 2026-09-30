---
name: ship-pr
description: Run checks, commit, push and open or update the Smart Beat PR, enable Auto-fix, and set board status. Use for "commit and push", "open the PR", "monitor the build".
---

Reply in English.

1. `source ~/.cargo/env && pnpm format && pnpm check`. Fix failures before committing.
2. Stage only intended files. Never commit user song files (for example `.gp4`/`.gp5` from Downloads, they may be commercial transcriptions) or local preview config (`.claude/launch.json`).
3. Commit with a conventional-style message (`feat:`, `fix:`, `test:`) and end it with the attribution line from the session's system reminder.
4. Push the branch. If no PR exists, `gh pr create` with a description covering summary, what changed per issue (`Closes #n`), test plan, and known limitations; end with the PR attribution line from the system reminder. Then call `mcp__ccd_pr__get_status` and `bind_pr` if it is not reported.
5. Move the linked issues to **In review** on board 3 (see `implement-issues` for commands).
6. Enable Auto-fix with `mcp__ccd_pr__set_monitor`. Do not poll CI yourself.
7. Report: commit hash, PR link, which checks are pending. Do not claim green before CI has run on that commit.
