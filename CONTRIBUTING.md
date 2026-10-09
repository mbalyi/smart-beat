# Contributing

## Contributions are welcome, and what that means

Pull requests, bug reports, suggestions and ideas are welcome. Smart Beat is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE) and may also be licensed commercially ([`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md)). So that this stays possible, contributing works like this:

- **You get no rights in the product.** Sending a pull request, a patch, an idea or any other help does not give you a licence to reuse, redistribute, sell or wrap Smart Beat. The [license](LICENSE) is the only thing that applies to you, like everybody else.
- **You do not become a part of the product.** You are not an owner or co-owner, you have no share in it or in what it earns, and you cannot claim any right in Smart Beat, its name, its code base as a whole or its future licensing because you contributed.
- **What you give.** By opening a pull request or sending a patch you confirm that you wrote it (or may send it) and that it contains nothing you may not share. You keep the copyright in your own contribution, and you give the maintainer a worldwide, perpetual, irrevocable, royalty-free right to use, change, copy, distribute and sublicense it as part of Smart Beat, including under other licences and in commercial licences, without asking you again and without paying you.
- **No obligation either way.** The maintainer may decline, change or remove any contribution, and does not have to give a reason. Contributions are unpaid.
- Ideas and suggestions given in issues and discussions can be used freely, without credit or payment.

These terms are a draft and have not been reviewed by a lawyer yet. If you cannot agree to them, please open an issue instead of a pull request.

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

Smart Beat is source-available (noncommercial licence), and its binaries may be licensed commercially, so dependency rules are strict. Read [`docs/licensing.md`](docs/licensing.md) before adding a dependency or reusing code.

- **Never copy code** from GPL/AGPL/LGPL projects. That includes MuseScore, TuxGuitar and PyGuitarPro.
- **New dependencies** must pass `pnpm licenses:check`. If a license isn't on the allowlist, don't add it to the allowlist yourself; raise it in the PR for review.
- **AI model weights** must allow commercial use and must not be bundled into installers.
