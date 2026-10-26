---
name: dialog-design
description: Design a new or reworked Smart Beat dialog in the modern look of Record to tab, AI Models, Import from Audio and What's new (neon frame, logo, graffiti art, stepper, fixed footer). Use whenever a dialog is added or visibly changed.
---

Reply in English.

New dialogs follow the structure of the four modern dialogs: **Record to tab** (`src/components/score/record-dialog.tsx`), **AI Models** / installer (`src/components/ai/ai-installer-dialog.tsx`), **Import from Audio** (`src/components/audio/audio-transcription-dialog.tsx`) and **What's new** (`src/components/whats-new-dialog.tsx`). Do not start from a plain `Dialog` with a title and a form unless the dialog is a small confirmation (see "When the plain look is fine").

## The structure we prefer

Top to bottom, inside one `Dialog` > `DialogContent`:

1. **Neon frame.** A coloured ring and glow around the window: `DIALOG_NEON` from `src/components/ai/dialog-art.tsx` (primary colour; What's new uses the `--brand` colour). A flow of several dialogs (like the AI ones) shares one fixed size through `AI_DIALOG_FRAME` (`dialog-frame.ts`) so the window never jumps between steps. Otherwise pick a size preset (`size="xl"`, `sm:max-w-4xl` for a wide one) and cap the height to the viewport, for example `h-[min(46rem,calc(100dvh-2rem))]`.
2. **A `relative isolate flex min-h-0 flex-1 flex-col` wrapper** around everything, so the artwork can sit behind the content (`-z-10`) and the body can scroll. Mount the content only while the dialog is open, so every visit starts from the defaults.
3. **Art layer** (`DialogArt`, or a small component like `WhatsNewArt`): graffiti splashes along the bottom corners (about 40 % and 20-30 % wide, `opacity-50` in light, `dark:opacity-90`) and, optionally, a hero picture for the current step on `md` and wider (`hidden md:block`). It is `aria-hidden`, `pointer-events-none` and `alt=""`. The text keeps clear of the hero with right padding (`md:pr-[20%]`, `md:pr-[48%]`).
4. **`DialogHeader`** with side padding `px-6 md:px-9` (or `md:px-10`):
   - the feature's **logo or title picture** (`DialogLogo` or an `img` in the `DialogTitle`), decorative, with the real title kept for screen readers in an `sr-only` span;
   - for a flow, the **`DialogStepper`** (one shared `Stepper`, centred across the dialog, done steps ticked, current step glowing);
   - a **title** (`text-2xl font-bold`, or `sr-only` when the logo says it) and a short **description** in plain words. Add a `Beta` badge when the feature is in beta.
5. **`DialogBody`**: the only part that scrolls. Same side padding as the header, `gap-3`. Group choices as **cards** (`rounded-xl border bg-card`), **toggle groups** and **tabs** with large targets (`h-9`, `text-sm font-semibold`); the selected item is filled with the primary colour (`data-[state=on]:bg-primary`), the others are `border-border bg-card`. Use icons from lucide-react with a text label, never an icon alone.
6. **`DialogFooter`** pinned at the bottom and transparent (`mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5`): a secondary `Back` / `Close` (`variant="outline" size="lg" className="min-w-28 bg-card"`) on the left and **one** primary action (`size="lg" className="min-w-52"`, with an inline arrow icon when it moves on) on the right. The close button in the corner and the footer never move.

Use the theme tokens (`primary`, `brand`, `card`, `border`, `muted-foreground`), never fixed greys, so light and dark both work. Plain words for a musician or a learner: say what the user gets and what to do next, not how it works inside.

## Artwork

Art lives in `src/assets/<dialog-name>/` as optimised `.webp` with a transparent background: `logo.webp`, `hero.webp`, `splash-bottom-left.webp`, `splash-bottom-right.webp`, and icons if the dialog needs them. Reuse the existing splashes and hero pictures of the AI flow when the dialog belongs to it. Prepare new pictures with the `process-asset` skill (transparent background, alpha check). If no artwork exists yet, build the layout with the same slots and say in the PR which pictures are still to be made; do not fall back to a grey layout.

## Accessibility and tests

- Title and description exist for screen readers (`DialogTitle`, `DialogDescription`); every picture that only decorates has `alt=""` and `aria-hidden`.
- Keep the text readable over the art in light and dark; the art never sits under controls that need contrast.
- Buttons are reachable by keyboard in the order they read; Escape closes the dialog, and a running job is stopped or confirmed first.
- Add a Vitest test for the content and a Playwright spec with an axe scan of the open dialog in light and dark (scan the popup itself with the `region` rule off). Then run the `ui-visual-check` skill: desktop, mobile (375x812), tablet, light and dark.

## When the plain look is fine

A one-question confirmation (discard, leave, delete) or a tiny settings popup (the count-in and metronome popups) stays small: `size="sm"`, `DialogHeader`, `DialogFooter`, no art, no stepper. Everything with several choices, several steps, a download or a result gets the modern layout above.
