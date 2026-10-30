import { act, fireEvent, screen, within } from "@testing-library/react";

import { StemPage } from "@/components/stems/stem-page";
import { STEM_LIMITS_URL } from "@/lib/project-info";
import { STEM_SPEEDS } from "@/lib/stems/player";
import type { StemSong } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { FakeStemPlayer } from "@/test/fake-stem-audio";
import { renderWithProviders } from "@/test/render";
import { STEM_SONG } from "@/test/tauri";

function setup(
  song: StemSong = STEM_SONG,
  state: ConstructorParameters<typeof FakeStemPlayer>[0] = {},
) {
  const player = new FakeStemPlayer({ duration: 215, ...state });
  const onBack = vi.fn();
  const createPlayer = vi.fn(() => player);
  const ui = renderWithProviders(
    <StemPage song={song} onBack={onBack} createPlayer={createPlayer} />,
  );
  return { ...ui, player, onBack, createPlayer };
}

const row = (kind: string) => screen.getByTestId(`stem-${kind}`);
/** The last gains the page gave the player. */
const gains = (player: FakeStemPlayer) => player.setGains.mock.calls.at(-1)![0];

describe("Stem page: the song", () => {
  it("shows the song's name as the heading, and goes back to the start", async () => {
    const { user, onBack } = setup();
    expect(screen.getByRole("heading", { level: 1, name: "Neon Nights" })).toBeInTheDocument();
    expect(screen.getByText(/3:35 · Fast\s+engine · 5 parts/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to start" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("loads the stems and stops the sound when it closes", () => {
    const { player, createPlayer, unmount } = setup();
    expect(createPlayer).toHaveBeenCalledWith(STEM_SONG);
    expect(player.load).toHaveBeenCalledOnce();
    unmount();
    expect(player.dispose).toHaveBeenCalledOnce();
  });

  it("says when there is no audio to play with", () => {
    renderWithProviders(<StemPage song={STEM_SONG} onBack={vi.fn()} createPlayer={() => null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("cannot play audio");
  });

  it("says while the stems load, and when one cannot be read", () => {
    const { player } = setup(STEM_SONG, { loaded: false });
    expect(screen.getAllByText("Loading the stems…").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    act(() => player.set({ error: "The stem could not be read." }));
    expect(screen.getByRole("alert")).toHaveTextContent("The stem could not be read.");
  });

  it("explains that a mono file could not be split", () => {
    setup({ ...STEM_SONG, mono: true, skipped: ["vocals", "panned"] });
    expect(screen.getByTestId("stems-skipped")).toHaveTextContent(
      "This file is mono, so vocals and guitars and keys cannot be separated. They stay in “Other (not separated)”.",
    );
  });

  it("links to what the separation can and cannot do", () => {
    setup();
    expect(screen.getByRole("link", { name: "What it can and cannot do" })).toHaveAttribute(
      "href",
      STEM_LIMITS_URL,
    );
    expect(STEM_LIMITS_URL).toMatch(/docs\/stem-separation-spike\.md$/);
  });
});

describe("Stem page: the rows", () => {
  it("has a row per stem, in the usual order, with its limit", () => {
    setup();
    const rows = within(screen.getByRole("list", { name: "Stems" })).getAllByRole("listitem");
    expect(rows.map((item) => within(item).getByRole("heading", { level: 2 }).textContent)).toEqual(
      ["Drums", "Bass", "Vocals", "Guitars and keys", "Other (not separated)"],
    );
    expect(row("drums")).toHaveTextContent("Faint cymbals and snare body can remain");
    expect(row("bass")).toHaveTextContent("A guitar playing the same notes can leak in");
    expect(row("vocals")).toHaveTextContent("Centred guitars and snare can leak in");
    expect(row("vocals")).toHaveTextContent("Mono files cannot be separated");
    expect(row("panned")).toHaveTextContent("hard-panned");
    expect(row("other")).toHaveTextContent("Everything that was not separated");
  });

  it("only has the stems the song has, and names Other for the neural engine", () => {
    setup({
      ...STEM_SONG,
      engine: "neural",
      stems: STEM_SONG.stems.filter((stem) => stem.kind !== "panned"),
    });
    expect(screen.queryByTestId("stem-panned")).not.toBeInTheDocument();
    expect(within(row("other")).getByRole("heading", { level: 2 })).toHaveTextContent("Other");
    expect(row("other")).not.toHaveTextContent("not separated");
  });

  it("draws the waveforms again once the stems are decoded", () => {
    const { player } = setup(STEM_SONG, { loaded: false });
    const path = () => screen.getByTestId("waveform-bass").querySelector("path")!.getAttribute("d");
    const silent = path();
    act(() => player.set({ loaded: true }));
    expect(path()).not.toBe(silent);
  });

  it("draws a waveform for each stem", () => {
    setup();
    for (const kind of ["drums", "bass", "vocals", "panned", "other"]) {
      expect(screen.getByTestId(`waveform-${kind}`).querySelector("path")).toHaveAttribute("d");
    }
  });
});

describe("Stem page: mute, solo and volume", () => {
  it("starts with every stem heard", () => {
    const { player } = setup();
    expect(gains(player)).toEqual({ drums: 1, bass: 1, vocals: 1, panned: 1, other: 1 });
  });

  it("mutes and unmutes a stem", async () => {
    const { user, player } = setup();
    const mute = within(row("bass")).getByRole("button", { name: "Mute Bass" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    await user.click(mute);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(gains(player).bass).toBe(0);
    expect(gains(player).drums).toBe(1);
    await user.click(mute);
    expect(gains(player).bass).toBe(1);
  });

  it("solos a stem, which silences the others and overrides its own mute", async () => {
    const { user, player } = setup();
    await user.click(within(row("drums")).getByRole("button", { name: "Mute Drums" }));
    await user.click(within(row("drums")).getByRole("button", { name: "Solo Drums" }));
    expect(gains(player)).toEqual({ drums: 1, bass: 0, vocals: 0, panned: 0, other: 0 });
    expect(row("bass")).toHaveAttribute("data-heard", "false");
    expect(row("drums")).toHaveAttribute("data-heard", "true");
    await user.click(within(row("vocals")).getByRole("button", { name: "Solo Vocals" }));
    expect(gains(player).vocals).toBe(1);
    await user.click(within(row("drums")).getByRole("button", { name: "Solo Drums" }));
    await user.click(within(row("vocals")).getByRole("button", { name: "Solo Vocals" }));
    // The mute of the drums is back once no stem is soloed.
    expect(gains(player)).toEqual({ drums: 0, bass: 1, vocals: 1, panned: 1, other: 1 });
  });

  it("changes the volume with the keyboard", async () => {
    const { user, player } = setup();
    const volume = within(row("vocals")).getByRole("slider", { name: "Volume, Vocals" });
    expect(volume).toHaveAttribute("aria-valuetext", "100%");
    volume.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(volume).toHaveAttribute("aria-valuetext", "90%");
    expect(gains(player).vocals).toBeCloseTo(0.9);
    await user.keyboard("{Home}");
    expect(gains(player).vocals).toBe(0);
  });

  it("is operable by keyboard alone", async () => {
    const { user, player } = setup();
    const mute = within(row("drums")).getByRole("button", { name: "Mute Drums" });
    mute.focus();
    await user.keyboard("{Enter}");
    expect(gains(player).drums).toBe(0);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(
      within(row("drums")).getByRole("button", { name: "Solo Drums" }),
    );
    await user.keyboard(" ");
    expect(gains(player).drums).toBe(1); // Solo on drums: the others are silent, drums heard
    expect(gains(player).bass).toBe(0);
  });
});

describe("Stem page: the transport", () => {
  it("plays and pauses", async () => {
    const { user, player } = setup();
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(player.play).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(player.pause).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(player.stop).toHaveBeenCalledOnce();
  });

  it("shows the time as a timer", () => {
    setup(STEM_SONG, { position: 75 });
    expect(screen.getByRole("timer", { name: "Position" })).toHaveTextContent("1:15 / 3:35");
  });

  it("seeks with the Position slider by keyboard", async () => {
    const { user, player } = setup(STEM_SONG, { position: 30 });
    const slider = screen.getByRole("slider", { name: "Position" });
    expect(slider).toHaveAttribute("aria-valuetext", "0:30 of 3:35");
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(player.seek).toHaveBeenLastCalledWith(31);
    await user.keyboard("{End}");
    expect(player.seek).toHaveBeenLastCalledWith(215);
  });

  it("seeks when a waveform is clicked", () => {
    const { player } = setup();
    const wave = screen.getByTestId("waveform-bass");
    wave.getBoundingClientRect = () => ({ left: 100, width: 400 }) as DOMRect;
    fireEvent.pointerDown(wave, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(wave, { clientX: 300, pointerId: 1 });
    expect(player.seek).toHaveBeenCalledWith(107.5);
    expect(player.setLoop).not.toHaveBeenCalled();
  });

  it("sets the loop by dragging over a waveform", () => {
    const { player } = setup();
    const wave = screen.getByTestId("waveform-drums");
    wave.getBoundingClientRect = () => ({ left: 0, width: 430 }) as DOMRect;
    fireEvent.pointerDown(wave, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(wave, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(wave, { clientX: 200, pointerId: 1 });
    expect(player.setLoop).toHaveBeenCalledWith({ start: 50, end: 100 });
    expect(player.seek).not.toHaveBeenCalled();
  });

  it("shows the countdown and the rendering state", () => {
    const { player } = setup();
    act(() => player.set({ countdown: 3 }));
    expect(screen.getByText("Starting in 3…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    act(() => player.set({ countdown: null, rendering: true }));
    expect(screen.getByText("Rendering…")).toBeInTheDocument();
    act(() => player.set({ rendering: false }));
    expect(screen.queryByText("Rendering…")).not.toBeInTheDocument();
  });
});

describe("Stem page: loop, speed and count-in", () => {
  it("sets the loop start and end at the playhead, and clears it", async () => {
    const { user, player } = setup();
    expect(screen.getByRole("button", { name: "Clear loop" })).toBeDisabled();

    player.livePosition = 20;
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    expect(screen.getByText(/Loop starts at 0:20. Set its end./)).toBeInTheDocument();
    expect(player.setLoop).toHaveBeenLastCalledWith(null);

    player.livePosition = 20.1;
    await user.click(screen.getByRole("button", { name: "Set loop end" }));
    expect(screen.getByText(/Put the end after the start/)).toBeInTheDocument();
    expect(player.state.loop).toBeNull();

    player.livePosition = 45;
    await user.click(screen.getByRole("button", { name: "Set loop end" }));
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 20, end: 45 });
    expect(screen.getByText(/Looping 0:20 to 0:45/)).toBeInTheDocument();

    // Moving the start keeps the end.
    player.livePosition = 30;
    await user.click(screen.getByRole("button", { name: "Set loop start" }));
    expect(player.setLoop).toHaveBeenLastCalledWith({ start: 30, end: 45 });

    await user.click(screen.getByRole("button", { name: "Clear loop" }));
    expect(player.setLoop).toHaveBeenLastCalledWith(null);
    expect(screen.getByText(/No loop/)).toBeInTheDocument();
  });

  it("offers the speeds 100 to 50 % and changes it", async () => {
    const { user, player } = setup();
    const group = screen.getByRole("radiogroup", { name: "Speed" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(STEM_SPEEDS.map((speed) => `${speed}%`));
    expect(within(group).getByRole("radio", { name: "Speed 100%" })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "Speed 80%" }));
    expect(player.setSpeed).toHaveBeenCalledWith(80);
    expect(within(group).getByRole("radio", { name: "Speed 80%" })).toBeChecked();
    // Clicking the chosen speed again does not leave the page without one.
    await user.click(within(group).getByRole("radio", { name: "Speed 80%" }));
    expect(player.setSpeed).toHaveBeenCalledTimes(1);
  });

  it("turns the count-in on, off by default", async () => {
    const { user, player } = setup();
    const count = screen.getByRole("switch", { name: /Count-in/ });
    expect(count).not.toBeChecked();
    await user.click(count);
    expect(player.setCountIn).toHaveBeenCalledWith(true);
    expect(count).toBeChecked();
  });
});

describe("Stem page: accessibility", () => {
  it("has no violations", async () => {
    setup(STEM_SONG, { position: 12 });
    await expectNoA11yViolations();
  });

  it("has no violations with a loop, a mono notice and rendering", async () => {
    const { player } = setup({ ...STEM_SONG, mono: true, skipped: ["vocals"] });
    act(() => player.set({ loop: { start: 10, end: 30 }, rendering: true, speed: 70 }));
    await expectNoA11yViolations();
  });
});
