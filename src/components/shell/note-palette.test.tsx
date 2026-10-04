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
