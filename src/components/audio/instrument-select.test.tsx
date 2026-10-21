import { screen } from "@testing-library/react";
import { useState } from "react";
import { InstrumentSelect } from "./instrument-select";
import { renderWithProviders } from "@/test/render";
import { expectNoA11yViolations } from "@/test/axe";

const IDS = ["acoustic_piano", "electric_piano", "drums"];
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<string[]>([]);
  return (
    <InstrumentSelect
      instruments={IDS}
      value={value}
      onChange={setValue}
      disabled={disabled}
      aria-describedby="x"
    />
  );
}

describe("InstrumentSelect", () => {
  it("searches, checks rows into chips and removes a chip", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: /Automatic detection/ }));
    await user.type(screen.getByLabelText("Search instruments"), "drum");
    expect(screen.queryByRole("checkbox", { name: "electric piano" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "drums" }));
    expect(screen.getByRole("button", { name: "Remove drums" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "drums" })).toBeChecked();
    await expectNoA11yViolations();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove drums" }));
    expect(screen.queryByRole("button", { name: "Remove drums" })).not.toBeInTheDocument();
  });
  it("says when nothing matches", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: /Automatic detection/ }));
    await user.type(screen.getByLabelText("Search instruments"), "zzzz");
    expect(screen.getByText("No matching instruments.")).toBeInTheDocument();
  });
  it("is inert when disabled", () => {
    renderWithProviders(<Harness disabled />);
    expect(screen.getByRole("button", { name: /Automatic detection/ })).toBeDisabled();
  });
});
