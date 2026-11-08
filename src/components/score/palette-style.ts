import type { PointerEvent } from "react";

import { ON_BRAND } from "@/components/ui/mixer-toggle-styles";
import type { ToggleState } from "@/lib/score/editor";

/**
 * The accessible name of a button whose icon is a written mark (WCAG 2.5.3,
 * Label in Name): the name carries the visible mark as separate words, so
 * "Palm mute, P.M." is read and can be spoken as "click P.M.".
 */
export function markedName(label: string, mark?: string): string {
  return mark ? `${label}, ${mark}` : label;
}

/**
 * Pressed (the brand purple, like every other toggle of the app), partly pressed (a selection
 * where only some have it) or not. The solid fill comes with an inset white ring, so the state
 * does not depend on telling colours apart.
 */
export const PRESSED: Record<ToggleState, string> = {
  on: ON_BRAND,
  mixed:
    "border-[#9a2ae6] bg-[linear-gradient(135deg,#9a2ae6_50%,transparent_50%)] text-white inset-ring-2 inset-ring-white/40",
  off: "",
};

/**
 * Keeps the pointer position in custom properties: `--mx` and `--my` on the cell under it (its ring
 * follows the pointer) and `--gx` and `--gy` on the toolbar or box around it (the mesh of
 * `.palette-mesh` is drawn around the pointer). One handler on a toolbar covers all of its cells,
 * and the cells of a box too (React events bubble through the portal).
 */
export function trackPointer(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const mesh = target.closest<HTMLElement>(".palette-mesh");
  if (mesh) {
    const rect = mesh.getBoundingClientRect();
    mesh.style.setProperty("--gx", `${event.clientX - rect.left}px`);
    mesh.style.setProperty("--gy", `${event.clientY - rect.top}px`);
  }
  const cell = target.closest<HTMLElement>(".palette-cell");
  if (!cell) return;
  const rect = cell.getBoundingClientRect();
  cell.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  cell.style.setProperty("--my", `${event.clientY - rect.top}px`);
}
