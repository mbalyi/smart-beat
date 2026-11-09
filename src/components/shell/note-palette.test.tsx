import { act, screen } from "@testing-library/react";

import { NotePalette } from "@/components/shell/note-palette";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("NotePalette", () => {
  it("shows the tools while editing, sliding in", async () => {
    renderWithProviders(
      <NotePalette editing>
        <button type="button">Quarter</button>
      </NotePalette>,
    );

    const palette = screen.getByRole("complementary", { name: "Note palette" });
    expect(palette).toHaveAttribute("data-state", "open");
    expect(palette.className).toContain("slide-in-from-left");
    expect(screen.getByRole("button", { name: "Quarter" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("is as wide as 8 icon cells and their gaps, and stacks above the score in narrow windows", () => {
    renderWithProviders(
      <NotePalette editing>
        <button type="button">Quarter</button>
      </NotePalette>,
    );
    const palette = screen.getByRole("complementary", { name: "Note palette" });
    expect(palette).toHaveAttribute("data-tour", "note-palette");
    expect(palette.className).toContain("w-[19.5rem]");
    expect(palette.className).toContain("max-lg:w-full");
    expect(palette.className).toContain("max-lg:max-h-32");
    expect(palette.className).toContain("overflow-y-auto");
  });

  it("is not rendered when edit mode is off", () => {
    renderWithProviders(
      <NotePalette editing={false}>
        <button type="button">Quarter</button>
      </NotePalette>,
    );

    expect(screen.queryByRole("complementary", { name: "Note palette" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Turn on edit mode/)).not.toBeInTheDocument();
  });

  it("slides out when edit mode is turned off, then goes away", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderWithProviders(
        <NotePalette editing>
          <button type="button">Quarter</button>
        </NotePalette>,
      );
      rerender(
        <NotePalette editing={false}>
          <button type="button">Quarter</button>
        </NotePalette>,
      );
      const palette = screen.getByRole("complementary", { name: "Note palette" });
      expect(palette).toHaveAttribute("data-state", "closed");
      act(() => vi.advanceTimersByTime(250));
      expect(screen.queryByRole("complementary", { name: "Note palette" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
