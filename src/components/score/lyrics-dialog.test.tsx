import { screen } from "@testing-library/react";

import { LyricsDialog } from "@/components/score/lyrics-dialog";
import { TextDialog } from "@/components/score/text-dialog";
import type { LyricLine } from "@/lib/score/lyrics";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setupLyrics(initial: LyricLine[] = []) {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <LyricsDialog
      open
      onOpenChange={onOpenChange}
      trackName="Voice"
      initial={initial}
      barCount={8}
      onSubmit={onSubmit}
    />,
  );
  return { ...utils, onSubmit, onOpenChange };
}

describe("LyricsDialog", () => {
  it("edits five lines, each with its start bar, and counts syllables", async () => {
    const { user, onSubmit, onOpenChange } = setupLyrics([{ startBar: 1, text: "first" }]);
    expect(screen.getByRole("dialog", { name: "Lyrics: Voice" })).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(5);
    expect(screen.getByRole("textbox", { name: "Line 1 text" })).toHaveValue("first");
    expect(screen.getAllByRole("spinbutton", { name: "Starts at bar" })[0]).toHaveValue(2);
    await expectNoA11yViolations();

    const line2 = screen.getByRole("textbox", { name: "Line 2 text" });
    await user.type(line2, "Hel-lo my+friend [[comment]");
    expect(line2).toHaveAccessibleDescription("3 syllables");
    const start = screen.getAllByRole("spinbutton", { name: "Starts at bar" })[1]!;
    await user.clear(start);
    await user.type(start, "3");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onSubmit).toHaveBeenCalledWith([
      { startBar: 1, text: "first" },
      { startBar: 2, text: "Hel-lo my+friend [comment]" },
      { startBar: 0, text: "" },
      { startBar: 0, text: "" },
      { startBar: 0, text: "" },
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("only accepts start bars inside the song", async () => {
    const { user, onSubmit } = setupLyrics();
    const start = screen.getAllByRole("spinbutton", { name: "Starts at bar" })[0]!;
    await user.clear(start);
    await user.type(start, "9");
    // Past the last bar: the form's own validation keeps it open.
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.clear(start);
    await user.type(start, "8");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit.mock.calls[0]![0][0]).toEqual({ startBar: 7, text: "" });
  });
});

describe("TextDialog", () => {
  function setupText(initial: string | null) {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    const utils = renderWithProviders(
      <TextDialog open onOpenChange={onOpenChange} initial={initial} onSubmit={onSubmit} />,
    );
    return { ...utils, onSubmit, onOpenChange };
  }

  it("writes text above the beat", async () => {
    const { user, onSubmit } = setupText(null);
    expect(screen.getByRole("dialog", { name: "Text" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove text" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Text" }), "  let it ring ");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenCalledWith("let it ring");
    await expectNoA11yViolations();
  });

  it("changes or removes existing text", async () => {
    const { user, onSubmit } = setupText("old");
    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("old");
    await user.clear(screen.getByRole("textbox", { name: "Text" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSubmit).toHaveBeenLastCalledWith(null);
  });

  it("removes text with its button", async () => {
    const { user, onSubmit } = setupText("old");
    await user.click(screen.getByRole("button", { name: "Remove text" }));
    expect(onSubmit).toHaveBeenCalledWith(null);
  });
});
