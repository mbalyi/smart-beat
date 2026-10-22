import { screen } from "@testing-library/react";

import { ModelPicker } from "@/components/ai/model-picker";
import { getAiState, resetAiStore, seedAiState, statusWith } from "@/lib/ai/ai-store";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

beforeEach(() => seedAiState({ ready: true, status: statusWith(["medium"]) }));
afterEach(() => resetAiStore());

function setup() {
  const onChange = vi.fn();
  const onDelete = vi.fn();
  const ui = renderWithProviders(
    <ModelPicker state={getAiState()} value="medium" onChange={onChange} onDelete={onDelete} />,
  );
  return { ...ui, onChange, onDelete };
}

describe("ModelPicker", () => {
  it("picks a size from anywhere on its row", async () => {
    const { user, onChange } = setup();
    await user.click(screen.getByText("~103M"));
    expect(onChange).toHaveBeenLastCalledWith("small");
    await user.click(screen.getByText("Slowest. Needs a strong graphics processor and patience."));
    expect(onChange).toHaveBeenLastCalledWith("large");
  });

  it("deletes without picking the row", async () => {
    const { user, onChange, onDelete } = setup();
    await user.click(screen.getByRole("button", { name: "Delete the Medium model" }));
    await user.click(screen.getByRole("button", { name: "Delete Medium" }));
    expect(onDelete).toHaveBeenCalledWith("medium");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not pick while disabled, and has no a11y violations", async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(
      <ModelPicker state={getAiState()} value="medium" onChange={onChange} disabled />,
    );
    await user.click(screen.getByText("~103M"));
    expect(onChange).not.toHaveBeenCalled();
    await expectNoA11yViolations();
  });
});
