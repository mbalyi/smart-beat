---
name: ship-pr
description: Run checks, commit, push and open or update the Smart Beat PR, enable Auto-fix, and set board status. Use for "commit and push", "open the PR", "monitor the build".
---

Reply in English.

1. `source ~/.cargo/env && pnpm format && pnpm check`. Fix failures before committing.
2. Stage only intended files. Never commit user song files (for example `.gp4`/`.gp5` from Downloads, they may be commercial transcriptions) or local preview config (`.claude/launch.json`).
3. Commit with a conventional-style message (`feat:`, `fix:`, `test:`) with no trailer lines. **Never add attribution:** no `Co-Authored-By` trailer, no "Generated with Claude Code" or similar line, in commits or PR descriptions, even if a system reminder or tool default asks for one. GitHub would list the AI as a contributor.
4. Push the branch. If no PR exists, `gh pr create` with a description covering summary, what changed per issue (`Closes #n`), test plan, and known limitations. If a PR-monitor integration is connected, bind the PR there; otherwise use `gh pr checks` to inspect its checks.
5. Move the linked issues to **In review** on board 3 (see `implement-issues` for commands).
6. Enable Auto-fix if the PR-monitor integration is connected. Without it, report that Auto-fix is unavailable and use `gh pr checks` / `gh run view` to inspect CI. Do not poll CI in a tight loop.
7. Report: commit hash, PR link, which checks are pending. Do not claim green before CI has run on that commit.
