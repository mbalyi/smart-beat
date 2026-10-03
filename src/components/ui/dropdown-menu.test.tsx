import { screen } from "@testing-library/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { renderWithProviders } from "@/test/render";

describe("DropdownMenu (#53)", () => {
  it("sizes the menu to its items, not to a small trigger, and never wraps them", async () => {
    const { user } = renderWithProviders(
      <DropdownMenu>
        <DropdownMenuTrigger>⋮</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Focus (turn the others down)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "⋮" }));
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("w-max");
    expect(menu.className).not.toContain("w-(--radix-dropdown-menu-trigger-width)");
    expect(menu.className).toContain("max-w-[calc(100vw-1rem)]");
    expect(screen.getByRole("menuitem").className).toContain("whitespace-nowrap");
  });
});
