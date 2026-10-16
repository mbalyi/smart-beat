# AI agent setup

Repository guidance and workflow skills have one shared source of truth so Codex and Claude Code can follow the same project rules.

## Layout

- [`AGENTS.md`](../AGENTS.md) holds repository-wide instructions. Codex reads it automatically, and [`CLAUDE.md`](../CLAUDE.md) points Claude Code to it.
- `.agents/skills/<name>/SKILL.md` holds each shared skill. Codex discovers skills in this directory.
- `.claude/skills/<name>` is a symlink to the corresponding `.agents/skills/<name>` directory for Claude Code discovery. Keep skill content in `.agents/skills/` and commit the symlinks.

When adding or renaming a skill, create the shared skill directory and add a matching symlink under `.claude/skills/`. Keep `name` and `description` in the front matter; put arguments and steps in the body so both providers can use the same instructions.

## Tool availability

The skills describe outcomes and prefer portable commands, but some actions need integrations that may not be available in every agent session.

| Action                      | Preferred path                                  | Portable fallback or requirement                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read issues, runs and PRs   | GitHub CLI (`gh`)                               | Install and authenticate `gh`; repository access and project updates may require the `project` scope.                                                                                            |
| Update project board        | `gh project`                                    | Requires GitHub CLI authentication with project permissions. If unavailable, report the board step as pending.                                                                                   |
| Browser visual checks       | Playwright (`pnpm test:e2e`) and a real browser | Use the provider's browser or desktop controls if connected. Claude's `preview_start`, `resize_window` and `read_console_messages` names are examples of one integration, not required commands. |
| Build/install the macOS app | `pnpm tauri build`, then macOS tools            | Requires macOS and permission to replace `/Applications/Smart Beat.app`; skip installation on other hosts or when permissions are unavailable.                                                   |
| PR monitoring and Auto-fix  | Connected PR-monitor integration, when present  | Use `gh pr checks` and `gh run view` to inspect CI. Auto-fix monitoring is unavailable without that integration.                                                                                 |
| Background tasks            | Provider task/session support                   | Run the command in a terminal session and continue other work while it runs; avoid tight polling loops.                                                                                          |

If an integration is missing, continue with the documented fallback where possible and name any action that remains unavailable. Do not claim an external action succeeded unless the tool confirms it.

## Contributing

Follow [`CONTRIBUTING.md`](../CONTRIBUTING.md), including the test, accessibility, responsiveness and licensing requirements. User authorization in the current conversation takes precedence over a skill's request for approval.
