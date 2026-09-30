---
name: user-stories-to-issues
description: Split a plan into user stories and create GitHub issues in mbalyi/smart-beat, added to project board 3.
argument-hint: <plan file or topic>
---

Reply in English. Issues and stories are written in English.

1. Read the plan (`$ARGUMENTS`, e.g. `high-level-plan.md`). Write stories as "As a … I want … so that …" with an acceptance-criteria checklist.
2. Show the story list to the user and get approval before creating anything.
3. Check `gh auth status` (needs the `project` scope; `gh` may live at `~/bin/gh`). Never open Jira.
4. List existing issues first (`gh issue list --limit 200`) and skip duplicates.
5. Create each issue with `gh issue create` using an epic label, plus `mvp` and `spike` where relevant.
6. Project 3 auto-adds new issues, so treat an "already added" error as success. At the end verify every issue is on the board (`gh project item-list 3 --owner mbalyi`) and add missing ones.
7. Report issue numbers with links, grouped by epic.
