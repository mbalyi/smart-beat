# Contributing

## Workflow

1. Pick an issue from the [project board](https://github.com/users/mbalyi/projects/3) and move it to **In progress**.
2. Branch from `main` (`feat/<short-name>` or `fix/<short-name>`).
3. Before pushing, run `pnpm check` and `pnpm test:e2e` locally. If you added dependencies, also run `pnpm licenses:check`.
4. Open a PR that closes the issue (`Closes #N`). CI must be green on all three OSes before merging.

## Standards

- **Accessibility is a requirement.**
  - Every interactive element must work with the keyboard and have an accessible name.
  - Modal dialogs must trap focus and return it on close. Non-modal panels that stay open while you work (the mixer) move focus in when opened, close with Escape and return focus.
  - New UI gets a Vitest test with `expectNoA11yViolations` (from `src/test/axe.ts`).
  - Full screens must pass the Playwright axe scan in both light and dark mode.
- **Responsive:** layouts must work from the minimum window size (480×360) up, with no horizontal scrolling. Add a case to `e2e/responsive.spec.ts` for new layouts.
- **Motion:** respect `prefers-reduced-motion` (handled globally in `src/index.css`; avoid JS animations that bypass it).
- **UI components:** use shadcn/ui (`pnpm dlx shadcn@latest add <component>`). Treat `src/components/ui/` as generated code and prefer composing over editing it.
- **Rust ↔ UI contracts:** when a command or event payload changes, update:
  - the Rust type;
  - the mirror type in `src/lib/tauri.ts`;
  - the fixtures in `src/test/tauri.ts` and `e2e/tauri-mock.js`;
  - `src-tauri/tests/ipc.rs`.
- **Tests:** logic gets unit tests, and user-visible flows get an integration test (`src/App.test.tsx` or `e2e/`). Coverage thresholds are enforced in `vitest.config.ts`.
- **Test songs:** only commit original songs (see `scripts/make-fixtures.mjs`), never transcriptions of commercial music.

## Licensing rules (important)

Smart Beat is closed source. Read [`docs/licensing.md`](docs/licensing.md) before adding a dependency or reusing code.

- **Never copy code** from GPL/AGPL/LGPL projects. That includes MuseScore, TuxGuitar and PyGuitarPro.
- **New dependencies** must pass `pnpm licenses:check`. If a license isn't on the allowlist, don't add it to the allowlist yourself; raise it in the PR for review.
- **AI model weights** must allow commercial use and must not be bundled into installers.
