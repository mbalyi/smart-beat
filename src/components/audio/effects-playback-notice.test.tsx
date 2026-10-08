import { screen } from "@testing-library/react";

import { EffectsPlaybackNotice } from "@/components/audio/effects-playback-notice";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("EffectsPlaybackNotice (#83)", () => {
  it("is a call to action while the engine is off, naming the switch behind it", async () => {
    const onEnable = vi.fn();
    const { user } = renderWithProviders(
      <EffectsPlaybackNotice engineOn={false} onEnable={onEnable} />,
    );
    expect(screen.getByText("Effects are not audible yet")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "“Native engine with effects” switch in the Inspector",
    );
    expect(screen.getByRole("status")).toHaveTextContent("saved either way");
    await user.click(screen.getByRole("button", { name: "Enable effects playback" }));
    expect(onEnable).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations();
  });

  it("says it needs the desktop app when the engine cannot be used here", () => {
    renderWithProviders(<EffectsPlaybackNotice engineOn={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Smart Beat desktop app");
  });

  it("words the drum mixer in the singular", () => {
    renderWithProviders(
      <EffectsPlaybackNotice subject="drum mixer" engineOn={false} onEnable={vi.fn()} />,
    );
    expect(screen.getByText("The drum mixer is not audible yet")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "It is heard only with the native audio engine",
    );
  });

  it("is a quiet confirmation once the engine is on", () => {
    renderWithProviders(<EffectsPlaybackNotice engineOn onEnable={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Effects playback is on");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
