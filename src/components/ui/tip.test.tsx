import { screen } from "@testing-library/react";
import { PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { hasText, nameFromTip } from "@/components/ui/tip";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("tooltips on icon buttons", () => {
  it("shows the tooltip on hover", async () => {
    const { user } = renderWithProviders(
      <Button title="Play (Space)">
        <PlayIcon />
      </Button>,
    );

    await user.hover(screen.getByRole("button"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Play (Space)");
  });

  it("shows the tooltip on keyboard focus and Escape dismisses it", async () => {
    const { user } = renderWithProviders(
      <Button title="Stop">
        <PlayIcon />
      </Button>,
    );

    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Stop");
    expect(screen.getByRole("button")).toHaveFocus();

    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(screen.getByRole("button")).toHaveFocus();
  });

  it("names an icon-only button from its tooltip text, without the native title", async () => {
    renderWithProviders(
      <Button title="Rest (R)">
        <PlayIcon />
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Rest (R)" });
    expect(button).not.toHaveAttribute("title");
    await expectNoA11yViolations();
  });

  it("keeps the name of buttons that have text or an aria-label", () => {
    renderWithProviders(
      <>
        <Button title="Open a song">Open…</Button>
        <Button title="Undo Add note" aria-label="Undo">
          <PlayIcon />
        </Button>
        <Toggle title="Loop the selected bars" aria-label="Loop">
          <PlayIcon />
        </Toggle>
      </>,
    );

    expect(screen.getByRole("button", { name: "Open…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loop" })).toBeInTheDocument();
  });

  it("works on toggles and toggle group items too", async () => {
    const { user } = renderWithProviders(
      <>
        <Toggle title="Metronome">
          <PlayIcon />
        </Toggle>
        <ToggleGroup type="single" aria-label="Note value">
          <ToggleGroupItem value="4" title="Quarter">
            <PlayIcon />
          </ToggleGroupItem>
        </ToggleGroup>
      </>,
    );

    expect(screen.getByRole("button", { name: "Metronome" })).toBeInTheDocument();
    await user.hover(screen.getByRole("radio", { name: "Quarter" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Quarter");
  });

  it("leaves buttons without a title alone", () => {
    renderWithProviders(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute("aria-label");
  });
});

describe("hasText and nameFromTip", () => {
  it("finds text, also inside elements and visually hidden text", () => {
    expect(hasText("Open")).toBe(true);
    expect(hasText(<span className="sr-only">Open</span>)).toBe(true);
    expect(hasText(["", <PlayIcon key="i" />])).toBe(false);
    expect(hasText(null)).toBe(false);
    expect(hasText(0)).toBe(true);
  });

  it("only names controls without a name of their own", () => {
    expect(nameFromTip("Tip", undefined, <PlayIcon />)).toBe("Tip");
    expect(nameFromTip("Tip", undefined, "Text")).toBeUndefined();
    expect(nameFromTip("Tip", "Label", <PlayIcon />)).toBe("Label");
    expect(nameFromTip(undefined, undefined, <PlayIcon />)).toBeUndefined();
  });
});

describe("tooltips keep the on/off state of toggles", () => {
  it("a pressed toggle and the checked item of a group still say they are on", () => {
    renderWithProviders(
      <>
        <Toggle title="Loop" pressed onPressedChange={() => {}} aria-label="Loop" />
        <Toggle title="Count-in" pressed={false} onPressedChange={() => {}} aria-label="Count-in" />
        <ToggleGroup type="single" value="4" aria-label="Note value">
          <ToggleGroupItem value="4" title="Quarter" aria-label="Quarter" />
          <ToggleGroupItem value="8" title="Eighth" aria-label="Eighth" />
        </ToggleGroup>
      </>,
    );

    expect(screen.getByRole("button", { name: "Loop" })).toHaveAttribute("data-state", "on");
    expect(screen.getByRole("button", { name: "Count-in" })).toHaveAttribute("data-state", "off");
    expect(screen.getByRole("radio", { name: "Quarter" })).toHaveAttribute("data-state", "on");
    expect(screen.getByRole("radio", { name: "Eighth" })).toHaveAttribute("data-state", "off");
  });

  it("toggles without a title keep Radix's own state", async () => {
    const { user } = renderWithProviders(<Toggle aria-label="Plain" />);
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "off");
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "on");
  });
});
