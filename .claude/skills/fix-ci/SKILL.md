---
name: fix-ci
description: Diagnose and fix a failing GitHub Actions run on a Smart Beat PR. Use when the user pastes a run/job URL or says the pipeline/build failed.
argument-hint: <PR number or run/job URL>
---

Reply in English, even if the user wrote in another language.

1. **Identify the run and commit**: `gh pr checks <pr> --repo mbalyi/smart-beat`, `gh run view <id> --json headSha,jobs`. Compare `headSha` with `git rev-parse HEAD`. If the failing run belongs to an older commit, check whether a later commit already fixes it; if so, say so and stop (Auto-fix events often name stale runs).
2. **Get the log**: `gh run view <id> --log-failed` or `gh api` for the job. If the shell is denied repeatedly, use the Terminal panel.
3. **Not a code problem?** If jobs died in seconds with no steps and the annotation says payments failed or the spending limit was hit, this is GitHub billing. Explain it, give `gh run rerun <id>` for after the user fixes billing, and offer to reduce CI minutes. Do not change code.
4. **Reproduce locally**, as close to CI as possible:
   - Linux/WebKit/Chromium e2e: Docker with `mcr.microsoft.com/playwright:v<version>-noble`, `--cpus=2` (try 1.2 for margin), `CI=1`, clean `public/` and no Vite cache. Build the source archive without macOS `._*` files (`COPYFILE_DISABLE=1 tar`).
   - Rust/Windows-only issues: read the crate source and reason from the error code; note that only the CI runner can confirm.
5. **Fix the root cause**, not the timeout, unless measurements show the environment is simply slower. Real app bugs found this way get a regression test that fails first.
6. **Verify**: `source ~/.cargo/env && pnpm check`, and the reproduced scenario passes repeatedly (at least 5 runs for flaky tests).
7. **Commit and push** (see `ship-pr`), make sure Auto-fix is enabled on the PR, and report what runs are pending. Never say it is green until CI ran on the new commit.
