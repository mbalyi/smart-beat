import { render, screen } from "@testing-library/react";
import { Stepper } from "./stepper";

describe("Stepper", () => {
  it("marks done, current and pending steps", () => {
    render(<Stepper steps={["One", "Two", "Three"]} current={1} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.dataset.state)).toEqual(["done", "active", "pending"]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("One")).toHaveTextContent("One (done)");
    expect(screen.getByText("Two")).toHaveTextContent("Two (current step)");
  });

  it("numbers from `start`, so a step can be numbered 0", () => {
    render(<Stepper steps={["Download", "Upload"]} current={0} start={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
