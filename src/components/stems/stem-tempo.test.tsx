import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { StemPage } from "@/components/stems/stem-page";
import type { DetectTempo } from "@/components/stems/use-stem-tempo";
import { forgetOverrides } from "@/lib/stems/tempo";
import type { StemMetronome } from "@/lib/stems/player";
import type { StemTempo } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeStemPlayer } from "@/test/fake-stem-audio";
import { renderWithProviders } from "@/test/render";
import { STEM_SONG } from "@/test/tauri";

const TEMPO: StemTempo = {
  bpm: 92,
  confidence: 0.9,
  firstBeatSec: 1.2,
  alternatives: [46, 184, 92],
  steady: true,
  sections: [],
};

const CHANGES: StemTempo = {
  ...TEMPO,
  steady: false,
  sections: [
    { startSec: 0, endSec: 108, bpm: 92 },
    { startSec: 108, endSec: 215, bpm: 140 },
  ],
};

function setup(tempo: StemTempo | Error | "never" = TEMPO, song = STEM_SONG) {
  const player = new FakeStemPlayer({ duration: 215 });
  const detect = vi.fn<DetectTempo>(() => {
    if (tempo === "never") return new Promise<StemTempo>(() => {});
    return tempo instanceof Error ? Promise.reject(tempo) : Promise.resolve(tempo);
  });
  const ui = renderWithProviders(
    <StemPage song={song} createPlayer={() => player} detectTempo={detect} />,
  );
  return { ...ui, player, detect };
}

/** The last tempo grid and settings the page gave the player. */
const metronome = (player: FakeStemPlayer): StemMetronome =>
  player.setMetronome.mock.calls.at(-1)![0];
const tempoButton = () => screen.findByTestId("stem-tempo");
const menu = () => screen.getByRole("dialog", { name: "Tempo" });

beforeEach(() => {
  forgetOverrides();
  localStorage.clear();
});

describe("the tempo in the song's details", () => {
  it("says it is finding the tempo, then shows it after the length and the model", async () => {
    let answer: (tempo: StemTempo) => void = () => {};
    const player = new FakeStemPlayer({ duration: 215 });
    renderWithProviders(
      <StemPage
        song={STEM_SONG}
        createPlayer={() => player}
        detectTempo={() => new Promise<StemTempo>((resolve) => (answer = resolve))}
      />,
    );
    expect(screen.getByText("Finding the tempo…")).toHaveAttribute("role", "status");
    // It never holds playback back.
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    await act(async () => answer(TEMPO));
    expect(await tempoButton()).toHaveTextContent("92 BPM");
    expect(screen.getByTestId("stems-info")).toHaveTextContent(
      /3:35 · Fast\s+engine · 5 parts · 92 BPM · Everything ran/,
    );
    expect(screen.queryByText("Finding the tempo…")).not.toBeInTheDocument();
  });

  it("asks for the tempo of the song once", async () => {
    const { detect } = setup();
    await tempoButton();
    expect(detect).toHaveBeenCalledExactlyOnceWith(STEM_SONG.id);
  });

  it.each([
    ["is not sure", { ...TEMPO, confidence: 0.1 }],
    ["fails", new Error("no tempo")],
  ])("says the tempo was not found when the detector %s", async (_name, answer) => {
    const { player } = setup(answer);
    expect(await tempoButton()).toHaveTextContent("Tempo not found");
    // Nothing to click along to until the user sets one.
    expect(screen.getByRole("button", { name: "Metronome" })).toBeDisabled();
    expect(metronome(player)).toMatchObject({ on: false, grid: null });
  });

  it("does not show Tempo changes for a steady song", async () => {
    setup();
    await tempoButton();
    expect(screen.queryByTestId("stem-tempo-changes")).not.toBeInTheDocument();
  });
});

describe("the tempo menu", () => {
  const open = async () => {
    const ui = setup();
    fireEvent.click(await tempoButton());
    return ui;
  };

  it("halves and doubles the tempo", async () => {
    const { player } = await open();
    fireEvent.click(within(menu()).getByRole("button", { name: "Halve" }));
    expect(await tempoButton()).toHaveTextContent("46 BPM");
    expect(metronome(player).grid?.segments[0]?.bpm).toBe(46);
    fireEvent.click(within(menu()).getByRole("button", { name: "Double" }));
    fireEvent.click(within(menu()).getByRole("button", { name: "Double" }));
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("184 BPM");
    expect(metronome(player).grid?.segments[0]?.bpm).toBe(184);
  });

  it("offers the detector's other candidates, without the tempo in use", async () => {
    await open();
    const others = within(menu()).getByRole("group", { name: "Other likely tempos" });
    expect(
      within(others)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["46 BPM", "184 BPM"]);
    fireEvent.click(within(others).getByRole("button", { name: "184 BPM" }));
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("184 BPM");
  });

  it("does not halve below the lowest tempo", async () => {
    const { player } = setup({ ...TEMPO, bpm: 50, alternatives: [] });
    fireEvent.click(await tempoButton());
    expect(within(menu()).getByRole("button", { name: "Halve" })).toBeDisabled();
    expect(metronome(player).grid?.segments[0]?.bpm).toBe(50);
  });

  it("takes a typed tempo with Enter, and keeps it within limits", async () => {
    const { user, player } = await open();
    const field = within(menu()).getByRole("spinbutton", { name: "Type a tempo" });
    await user.clear(field);
    await user.type(field, "128.5{Enter}");
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("128.5 BPM");
    expect(metronome(player).grid?.segments[0]?.bpm).toBe(128.5);
    await user.clear(field);
    await user.type(field, "900");
    await user.tab();
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("300 BPM");
  });

  it("sets the tempo from taps", async () => {
    await open();
    const now = vi.spyOn(Date, "now");
    const tap = (at: number) => {
      now.mockReturnValue(at);
      fireEvent.click(within(menu()).getByRole("button", { name: "Tap tempo" }));
    };
    tap(10_000);
    expect(within(menu()).getByText("Keep tapping.")).toBeInTheDocument();
    tap(10_500);
    tap(11_000);
    tap(11_500);
    // Half a second apart = 120 beats a minute.
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("120 BPM");
    expect(within(menu()).getByText(/120 BPM from 4 taps/)).toBeInTheDocument();
    // A pause starts the count again.
    tap(20_000);
    tap(20_600);
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("100 BPM");
    now.mockRestore();
  });

  it("lets the user set a tempo when none was found", async () => {
    const { player, user } = setup({ ...TEMPO, confidence: 0.05 });
    fireEvent.click(await tempoButton());
    expect(screen.getByTestId("stem-tempo-source")).toHaveTextContent("Not found");
    await user.type(within(menu()).getByRole("spinbutton", { name: "Type a tempo" }), "96{Enter}");
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("96 BPM");
    expect(screen.getByRole("button", { name: "Metronome" })).toBeEnabled();
    expect(metronome(player).grid?.segments[0]?.bpm).toBe(96);
  });

  it("puts the first beat at the playhead", async () => {
    const { player } = await open();
    expect(metronome(player).grid?.firstBeatSec).toBe(1.2);
    player.livePosition = 12.5;
    fireEvent.click(within(menu()).getByRole("button", { name: "First beat is at the playhead" }));
    expect(metronome(player).grid?.firstBeatSec).toBe(12.5);
    expect(within(menu()).getByText(/The first beat is at 0:12/)).toBeInTheDocument();
  });

  it("keeps what the user set for the song, which wins over what was detected", async () => {
    const first = await open();
    fireEvent.click(within(menu()).getByRole("button", { name: "Double" }));
    expect(JSON.parse(localStorage.getItem(`smart-beat:stem-tempo:${STEM_SONG.id}`)!)).toEqual({
      bpm: 184,
    });
    first.unmount();
    const { player } = setup();
    expect(await tempoButton()).toHaveTextContent("184 BPM");
    expect(metronome(player).grid?.segments[0]?.bpm).toBe(184);
    // And from storage alone, in a new session.
    forgetOverrides();
    screen.getByTestId("stem-tempo");
    fireEvent.click(screen.getByTestId("stem-tempo"));
    fireEvent.click(within(menu()).getByRole("button", { name: "Use what was detected" }));
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("92 BPM");
    expect(localStorage.getItem(`smart-beat:stem-tempo:${STEM_SONG.id}`)).toBeNull();
  });

  it("still works when storage is unavailable", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await open();
    fireEvent.click(within(menu()).getByRole("button", { name: "Halve" }));
    expect(screen.getByTestId("stem-tempo")).toHaveTextContent("46 BPM");
    set.mockRestore();
  });

  it("has no accessibility violations", async () => {
    await open();
    await expectNoA11yViolations();
  });
});

describe("the metronome on the page", () => {
  it("clicks at the tempo, from the first beat, with the sound and volume chosen", async () => {
    const { player, user } = setup();
    await tempoButton();
    expect(metronome(player).on).toBe(false);
    await user.click(screen.getByRole("button", { name: "Metronome" }));
    expect(metronome(player)).toEqual({
      on: true,
      sound: "classic",
      volume: 1,
      grid: { firstBeatSec: 1.2, segments: [{ startSec: 0, bpm: 92 }] },
    });
    await user.click(screen.getByRole("button", { name: "Click sound and volume" }));
    fireEvent.change(screen.getByRole("slider", { name: /Click volume/ }), {
      target: { value: "2" },
    });
    expect(metronome(player).volume).toBe(2);
    await user.click(screen.getByRole("combobox", { name: "Click sound" }));
    await user.click(await screen.findByRole("option", { name: "Cowbell" }));
    expect(metronome(player).sound).toBe("cowbell");
    // The song page remembers the same.
    expect(JSON.parse(localStorage.getItem("smart-beat:practice")!)).toMatchObject({
      metronome: true,
      metronomeSound: "cowbell",
      metronomeVolume: 2,
    });
  });

  it("sits in the transport, between the speed and the count-in", async () => {
    setup();
    await tempoButton();
    const transport = screen.getByRole("region", { name: "Transport" });
    const names = within(transport)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    const metronomeAt = names.indexOf("Metronome");
    expect(metronomeAt).toBeGreaterThan(names.indexOf("Set loop end"));
    expect(metronomeAt).toBeLessThan(names.indexOf("Count-in"));
  });

  it("follows the first beat set at the playhead while it is on", async () => {
    const { player, user } = setup();
    await tempoButton();
    await user.click(screen.getByRole("button", { name: "Metronome" }));
    fireEvent.click(screen.getByTestId("stem-tempo"));
    player.livePosition = 3;
    fireEvent.click(within(menu()).getByRole("button", { name: "First beat is at the playhead" }));
    expect(metronome(player)).toMatchObject({ on: true });
    expect(metronome(player).grid?.firstBeatSec).toBe(3);
  });
});

describe("tempo changes", () => {
  const openChanges = async () => {
    const ui = setup(CHANGES);
    fireEvent.click(await screen.findByTestId("stem-tempo-changes"));
    return ui;
  };

  it("shows Tempo changes, with the parts in a small menu", async () => {
    await openChanges();
    const popover = screen.getByRole("dialog", { name: "Tempo changes" });
    expect(within(popover).getByTestId("stem-tempo-sentence")).toHaveTextContent(
      "92 BPM until 1:48, then 140 BPM",
    );
    expect(within(popover).getByText("92 BPM")).toBeInTheDocument();
    expect(within(popover).getByText("140 BPM")).toBeInTheDocument();
  });

  it("says where the playhead is", async () => {
    const { player } = await openChanges();
    act(() => player.set({ position: 150 }));
    expect(screen.getByText("The playhead is in the 140 BPM part.")).toBeInTheDocument();
    act(() => player.set({ position: 10 }));
    expect(screen.getByText("The playhead is in the 92 BPM part.")).toBeInTheDocument();
  });

  it("uses one tempo unless asked to follow the changes", async () => {
    const { player, user } = await openChanges();
    expect(metronome(player).grid?.segments).toEqual([{ startSec: 0, bpm: 92 }]);
    expect(
      screen.getByText(/clicks at one tempo, even where the song changes/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Follow the tempo changes" }));
    expect(metronome(player).grid?.segments).toEqual([
      { startSec: 0, bpm: 92 },
      { startSec: 108, bpm: 140 },
    ]);
  });

  it("tells in the tempo menu that the click uses one tempo", async () => {
    setup(CHANGES);
    fireEvent.click(await tempoButton());
    expect(within(menu()).getByText(/The metronome uses one tempo/)).toBeInTheDocument();
  });

  it("has no accessibility violations with the menu open", async () => {
    await openChanges();
    await expectNoA11yViolations();
  });
});

it("asks again when another song opens", async () => {
  const player = new FakeStemPlayer({ duration: 215 });
  const detect = vi.fn<DetectTempo>(async (id) =>
    id === "other" ? { ...TEMPO, bpm: 140 } : TEMPO,
  );
  const view = renderWithProviders(
    <StemPage song={STEM_SONG} createPlayer={() => player} detectTempo={detect} />,
  );
  expect(await tempoButton()).toHaveTextContent("92 BPM");
  view.rerender(
    <StemPage
      song={{ ...STEM_SONG, id: "other" }}
      createPlayer={() => player}
      detectTempo={detect}
    />,
  );
  await waitFor(() => expect(screen.getByTestId("stem-tempo")).toHaveTextContent("140 BPM"));
});
