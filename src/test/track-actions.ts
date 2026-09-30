import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Picks an action from a track row's "⋮" menu in the track list. */
export async function trackAction(user: UserEvent, track: string, action: string) {
  await user.click(screen.getByRole("button", { name: `Actions for ${track}` }));
  await user.click(await screen.findByRole("menuitem", { name: action }));
}
