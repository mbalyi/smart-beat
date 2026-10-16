import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CoachCard } from "@/components/tour/coach-mark";
import { expectNoA11yViolations } from "@/test/axe";

const choices = [
  { id: "editing", title: "Editing tour", description: "Write notes and drums." },
  { id: "effects", title: "Effects tour", description: "Effects and the pedalboard." },
];

describe("CoachCard", () => {
  it("offers the other tours on the last step and reports the one picked", async () => {
    const onChoose = vi.fn();
    render(
      <CoachCard
        index={9}
        size={10}
        title="You are set"
        body="Pick a short tour:"
        isLast
        canGoBack
        choices={choices}
        onChoose={onChoose}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: /Effects tour/ }));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("effects");
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("has no tour list without choices", () => {
    render(<CoachCard index={0} size={3} title="A" body="B" isLast={false} canGoBack={false} />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("draws inside a dialog as a strip, with Next focused and no violations", async () => {
    render(
      <CoachCard
        inline
        index={2}
        size={5}
        title="Speed"
        body="Start at 60%."
        isLast={false}
        canGoBack
        onNext={vi.fn()}
      />,
    );
    const card = screen.getByTestId("coach-mark");
    expect(card).toHaveClass("mx-3");
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    await expectNoA11yViolations(card);
  });
});
