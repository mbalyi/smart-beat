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
