import axe from "axe-core";
import { expect } from "vitest";

/**
 * Fails with a readable list if axe-core finds accessibility violations.
 *
 * `color-contrast` is skipped because jsdom cannot compute styles; contrast is
 * checked in the Playwright tests instead. Pass `{ page: true }` for full-page
 * renders so landmark rules (`region`) apply.
 */
export async function expectNoA11yViolations(
  container: Element = document.body,
  { page = false }: { page?: boolean } = {},
) {
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: page },
    },
  });
  const violations = results.violations.map(
    (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(violations).toEqual([]);
}
