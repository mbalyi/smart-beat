import { act, render, screen } from "@testing-library/react";

import { Playhead } from "@/components/playhead";
import { PlayheadStore } from "@/lib/score/playhead";

describe("Playhead", () => {
  it("is hidden until playback starts, then follows the bar position", () => {
    const store = new PlayheadStore();
    const { rerender } = render(<Playhead store={store} barWidth={20} playing={false} />);
    expect(screen.queryByTestId("playhead")).toBeNull();

    rerender(<Playhead store={store} barWidth={20} playing />);
    expect(screen.getByTestId("playhead")).toHaveStyle({ left: "0px" });
    act(() => store.set(2.5));
    expect(screen.getByTestId("playhead")).toHaveStyle({ left: "50px" });
    expect(screen.getByTestId("playhead")).toHaveAttribute("aria-hidden", "true");
  });

  it("stays where playback was paused", () => {
    const store = new PlayheadStore();
    store.set(1);
    render(<Playhead store={store} barWidth={40} playing={false} />);
    expect(screen.getByTestId("playhead")).toHaveStyle({ left: "40px" });
  });
});
