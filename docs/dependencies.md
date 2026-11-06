# Dependency updates

Dependabot does not open pull requests for new versions, so the PR list stays about real work. A weekly workflow files one issue that lists what is outdated instead.

## How it works

- [`.github/dependabot.yml`](../.github/dependabot.yml) keeps an entry for npm, Cargo and GitHub Actions with `open-pull-requests-limit: 0`. That turns off **version-update** pull requests.
- **Security updates are not affected.** Dependabot still opens a pull request for a vulnerable dependency; review and merge those as usual.
- [`dependency-report.yml`](../.github/workflows/dependency-report.yml) runs on Mondays at 06:00 UTC (and on demand from the Actions tab). It runs `scripts/dependency-report.mjs`, which reads `pnpm outdated`, `cargo outdated --root-deps-only` and the newest release of every action used in `.github/workflows/`.
- When anything is outdated, the workflow opens an issue titled `Dependency updates, week of <date>` with the label `dependencies` and closes last week's one with a link to the new one. When everything is current, it files nothing.

## Updating

Pick what you want from the issue and update it in one branch and one PR, as for any other batch of work. Run `pnpm check`, and `pnpm licenses:check` after changing packages or crates.

## Notes

- The report lists direct dependencies only (`--root-deps-only` for Cargo). Transitive updates come with `cargo update` and `pnpm update`.
- An action is listed only when its newest release has a higher major version than the one pinned in the workflows.
- To change the day, edit the `cron` line. To get pull requests back for one ecosystem, raise its `open-pull-requests-limit`.
