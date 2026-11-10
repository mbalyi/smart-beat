import { fireEvent, screen } from "@testing-library/react";

import { ScoreContextMenu, type ScoreMenuActions } from "@/components/score/score-context-menu";
import { newBeat, type Beat } from "@/lib/score/model";
import { renderWithProviders } from "@/test/render";

function setup(props: { editing?: boolean; canPaste?: boolean; beatAt?: () => Beat | null } = {}) {
  const actions = Object.fromEntries(
    [
      "onPlayFrom",
      "onLoopBar",
      "onLoopStart",
      "onLoopEnd",
      "onPracticeSection",
      "onTrainer",
      "onCopy",
      "onCut",
      "onDelete",
      "onLoopSelection",
      "onPracticeSelection",
      "onPlaySelection",
      "onInsertBarBefore",
      "onInsertBarAfter",
      "onCopyBar",
      "onCutBar",
      "onDeleteBar",
      "onPasteBarsAfter",
      "onInsertRest",
    ].map((name) => [name, vi.fn()]),
  ) as unknown as ScoreMenuActions;
  const ui = renderWithProviders(
    <ScoreContextMenu barAt={() => 2} sections={[]} actions={actions} {...props}>
      <div data-testid="score">score</div>
    </ScoreContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId("score"));
  return { ...ui, actions };
}

describe("ScoreContextMenu: bars (Edit Mode)", () => {
  it("offers the bar actions under the pointer while editing", async () => {
    const { user, actions } = setup({ editing: true });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(
      expect.arrayContaining([
        "Insert bar before",
        "Insert bar after",
        "Copy bar",
        "Cut bar",
        "Delete bar",
      ]),
    );
    // Nothing on the clipboard: no paste.
    expect(screen.queryByRole("menuitem", { name: "Paste bar after" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Insert bar after" }));
    expect(actions.onInsertBarAfter).toHaveBeenCalledWith(2);
  });

  it("inserts a rest before or after the right-clicked beat (#228)", async () => {
    const beat = newBeat(4);
    const { user, actions } = setup({ editing: true, beatAt: () => beat });
    await user.click(await screen.findByRole("menuitem", { name: "Insert rest before" }));
    expect(actions.onInsertRest).toHaveBeenCalledWith("before", beat);

    fireEvent.contextMenu(screen.getByTestId("score"));
    await user.click(await screen.findByRole("menuitem", { name: "Insert rest after" }));
    expect(actions.onInsertRest).toHaveBeenLastCalledWith("after", beat);
  });

  it("offers no rest insertion outside Edit Mode", async () => {
    setup();
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: "Insert rest before" })).not.toBeInTheDocument();
  });

  it("runs each action on the clicked bar", async () => {
    const { user, actions } = setup({ editing: true, canPaste: true });
    await user.click(await screen.findByRole("menuitem", { name: "Delete bar" }));
    expect(actions.onDeleteBar).toHaveBeenCalledWith(2);
  });

  it("offers paste only when there is something to paste", async () => {
    const { user, actions } = setup({ editing: true, canPaste: true });
    await user.click(await screen.findByRole("menuitem", { name: "Paste bar after" }));
    expect(actions.onPasteBarsAfter).toHaveBeenCalledWith(2);
  });

  it("keeps the score read-only outside Edit Mode", async () => {
    setup({ editing: false, canPaste: true });
    await screen.findByRole("menuitem", { name: "Play from here" });
    for (const name of ["Insert bar before", "Copy bar", "Cut bar", "Delete bar"]) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    }
  });
});
