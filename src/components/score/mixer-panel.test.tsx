import { screen, within } from "@testing-library/react";

import { MixerPanel } from "@/components/score/mixer-panel";
import { mixFromScore } from "@/lib/score/mixer";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { SUMMARY } from "@/test/score";

function setup(overrides: Partial<Parameters<typeof MixerPanel>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    tracks: SUMMARY.tracks,
    mix: mixFromScore(SUMMARY),
    onChange: vi.fn(),
    onReset: vi.fn(),
    soundFont: "sonivox" as const,
    onSoundFontChange: vi.fn(),
    saved: true,
    ...overrides,
  };
  return { ...renderWithProviders(<MixerPanel {...props} />), props };
}

const strip = (name: string) => screen.getByRole("heading", { name }).closest("li")!;

describe("MixerPanel", () => {
  it("shows master volume, sounds and a strip per track", async () => {
    setup();

    const panel = screen.getByRole("dialog", { name: "Mixer" });
    expect(panel).toHaveTextContent("Changes are saved for this song.");
    expect(screen.getByRole("slider", { name: "Master volume" })).toHaveAttribute(
      "aria-valuetext",
      "100%",
    );
    expect(screen.getByRole("combobox", { name: "Instrument sounds" })).toHaveTextContent(
      "Standard",
    );
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("slider", { name: "Volume, Bass" })).toHaveAttribute(
      "aria-valuetext",
      "75%",
    );
    expect(screen.getByRole("slider", { name: "Pan, Bass" })).toHaveAttribute(
      "aria-valuetext",
      "50% left",
    );
    expect(screen.getByRole("button", { name: "Mute Piano" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoA11yViolations();
  });

  it("explains that the mix is not saved outside the desktop app", () => {
    setup({ saved: false });
    expect(screen.getByText("Changes last until you open another song.")).toBeInTheDocument();
  });

  it("dims tracks that are not heard", () => {
    const mix = mixFromScore(SUMMARY);
    mix.tracks[0]!.solo = true;
    setup({ mix });

    expect(strip("Guitar")).not.toHaveClass("bg-muted/50");
    expect(strip("Bass")).toHaveClass("bg-muted/50"); // another track is soloed
    expect(strip("Piano")).toHaveClass("bg-muted/50"); // muted
  });

  it("mutes and solos tracks", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("button", { name: "Mute Guitar" }));
    await user.click(screen.getByRole("button", { name: "Solo Drums" }));
    await user.click(screen.getByRole("button", { name: "Mute Piano" }));

    expect(vi.mocked(props.onChange).mock.calls).toEqual([
      [{ type: "mute", track: 0, value: true }],
      [{ type: "solo", track: 2, value: true }],
      [{ type: "mute", track: 3, value: false }],
    ]);
  });

  it("changes volumes live", async () => {
    const { user, props } = setup();

    screen.getByRole("slider", { name: "Volume, Guitar" }).focus();
    await user.keyboard("{ArrowLeft}");
    screen.getByRole("slider", { name: "Master volume" }).focus();
    await user.keyboard("{Home}");

    expect(props.onChange).toHaveBeenCalledWith({ type: "volume", track: 0, value: 0.93 });
    expect(props.onChange).toHaveBeenCalledWith({ type: "master", value: 0 });
  });

  it("shows pan while dragging and applies it when released", async () => {
    const { user, props } = setup();

    screen.getByRole("slider", { name: "Pan, Guitar" }).focus();
    await user.keyboard("{ArrowRight}");

    // Radix reports both for a key press (the commit first).
    expect(props.onChange).toHaveBeenCalledTimes(2);
    expect(props.onChange).toHaveBeenCalledWith(
      { type: "pan", track: 0, value: 0.125 },
      { commit: false },
    );
    expect(props.onChange).toHaveBeenCalledWith({ type: "pan", track: 0, value: 0.125 });
  });

  it("switches instrument sounds", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("combobox", { name: "Instrument sounds" }));
    await user.click(await screen.findByRole("option", { name: /High quality/ }));

    expect(props.onSoundFontChange).toHaveBeenCalledWith("fluidr3");
  });

  it("resets to the file's mix and closes", async () => {
    const { user, props } = setup();

    await user.click(screen.getByRole("button", { name: "Reset to the file's mix" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(props.onReset).toHaveBeenCalledOnce();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open while the rest of the window is used", async () => {
    const { user, props } = setup();

    await user.click(document.body);

    expect(props.onOpenChange).not.toHaveBeenCalled();
  });
});
