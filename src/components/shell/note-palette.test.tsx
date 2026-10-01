import { screen } from "@testing-library/react";

import { NotePalette } from "@/components/shell/note-palette";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("NotePalette", () => {
  it("shows the tools while editing", async () => {
    renderWithProviders(
      <NotePalette editing>
        <button type="button">Quarter</button>
      </NotePalette>,
    );

    expect(screen.getByRole("complementary", { name: "Note palette" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarter" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("explains how to start editing otherwise, and hides the tools", () => {
    renderWithProviders(
      <NotePalette editing={false}>
        <button type="button">Quarter</button>
      </NotePalette>,
    );

    expect(screen.getByText(/Turn on edit mode/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quarter" })).not.toBeInTheDocument();
  });
});
