---
name: ui-visual-check
description: Visually and accessibility-check a Smart Beat UI change in the browser pane (responsive widths, light/dark, axe scan, keyboard-only).
---

Reply in English.

1. Start the dev server with `preview_start` and open the changed screen.
2. Check desktop, then `resize_window` to mobile (375x812) and tablet, then **reset to desktop preset**.
3. Check light and dark (`colorScheme`).
4. Run the axe scan helper used by `e2e/accessibility.spec.ts` in both themes and at the smallest supported window size. For open popups/menus (Radix portals), scan the popup itself with the `region` rule off, and scan the page separately.
5. Walk the feature by keyboard only (Tab order, Enter/Space, Escape). Overlays such as the splash screen must be `inert` so they leave the tab order.
6. Add or update Playwright specs for anything found, and run them on Chromium and WebKit: `pnpm test:e2e`.
