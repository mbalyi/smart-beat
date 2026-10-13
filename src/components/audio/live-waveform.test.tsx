import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveWaveform } from "@/components/audio/live-waveform";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const heights = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-bar]")).map((bar) => bar.style.height);

describe("LiveWaveform", () => {
  it("is a meter with the current level", () => {
    render(<LiveWaveform level={0.5} />);
    const meter = screen.getByRole("meter", { name: "Input level" });
    expect(meter).toHaveAttribute("aria-valuenow", "50");
  });

  it("starts flat and moves new levels in from the right", () => {
    const { rerender } = render(<LiveWaveform level={0} bars={4} />);
    expect(heights()).toEqual(["6%", "6%", "6%", "6%"]);
    rerender(<LiveWaveform level={0.5} bars={4} />);
    act(() => vi.advanceTimersByTime(60));
    expect(heights()).toEqual(["6%", "6%", "6%", "50%"]);
    rerender(<LiveWaveform level={0.25} bars={4} />);
    act(() => vi.advanceTimersByTime(60));
    expect(heights()).toEqual(["6%", "6%", "50%", "25%"]);
  });

  it("turns a bar red near clipping", () => {
    render(<LiveWaveform level={1} bars={2} />);
    act(() => vi.advanceTimersByTime(60));
    const bars = document.querySelectorAll("[data-bar]");
    expect(bars[1]).toHaveClass("bg-destructive");
    expect(bars[0]).not.toHaveClass("bg-destructive");
  });
});
