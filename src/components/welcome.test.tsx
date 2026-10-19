import { screen, waitFor, within } from "@testing-library/react";

import { Welcome } from "@/components/welcome";
import { FEATURES } from "@/components/welcome-features";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function renderWelcome() {
  const onImportAudio = vi.fn();
  const onOpenFile = vi.fn();
  const onNewSong = vi.fn();
  const onShowShortcuts = vi.fn();
  const utils = renderWithProviders(
    <Welcome
      onImportAudio={onImportAudio}
      onOpenFile={onOpenFile}
      onNewSong={onNewSong}
      onShowShortcuts={onShowShortcuts}
    />,
  );
  return { ...utils, onImportAudio, onOpenFile, onNewSong, onShowShortcuts };
}

describe("Welcome", () => {
  it("has one h1 and a logical heading order", () => {
    renderWelcome();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Features" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(FEATURES.length);
  });

  it("starts with the title, without a preview badge", () => {
    renderWelcome();

    expect(screen.queryByText(/early preview/i)).not.toBeInTheDocument();
  });

  it("thanks alphaTab first, after the features, with its logo, and says who made cpal", async () => {
    const onShowLicenses = vi.fn();
    const { user } = renderWithProviders(
      <Welcome
        onOpenFile={vi.fn()}
        onImportAudio={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        onShowLicenses={onShowLicenses}
      />,
    );

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[headings.length - 3]).toBe("Features");
    expect(headings[headings.length - 2]).toBe("Made possible by open source.");
    // The optional add-ons are a section of their own, after the libraries (#150).
    expect(headings[headings.length - 1]).toBe("Add-ons you download yourself.");
    const section = screen
      .getByRole("heading", { name: "Made possible by open source." })
      .closest("section")!;
    const links = within(section).getAllByRole("link");
    expect(links[0]).toHaveAccessibleName("alphaTab");
    expect(links[0]).toHaveAttribute("href", "https://alphatab.net/");
    expect(within(section).getByRole("link", { name: "star alphaTab on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/CoderLine/alphaTab",
    );
    expect(section).toHaveTextContent("not affiliated with or endorsed by alphaTab");
    // alphaTab, six projects and the star link.
    expect(links).toHaveLength(1 + 6 + 1);
    expect(within(section).getByRole("link", { name: "RustySynth" })).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Basic Pitch" })).toHaveAttribute(
      "href",
      "https://github.com/spotify/basic-pitch",
    );
    expect(within(section).getByRole("link", { name: "Transkun" })).toHaveAttribute(
      "href",
      "https://github.com/Yujia-Yan/Transkun",
    );
    expect(within(section).getByRole("link", { name: "cpal by RustAudio" })).toHaveAttribute(
      "href",
      "https://github.com/RustAudio/cpal",
    );
    expect(within(section).queryByRole("link", { name: "React" })).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: /View open-source notices/ }));
    expect(onShowLicenses).toHaveBeenCalledOnce();
  });

  it("opens a card with the details and a link when a library is focused", async () => {
    const { user } = renderWelcome();

    await user.tab(); // reaches the first controls; go straight to the library instead
    screen.getByRole("link", { name: "RustySynth" }).focus();

    expect(await screen.findByText(/Turns notes and SoundFonts into sound/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Explore project/ })).toHaveAttribute(
      "href",
      "https://github.com/sinshu/rustysynth",
    );
  });

  it("orders the features: what works first, the AI ideas last, Hum to accompaniment at the end", () => {
    expect(FEATURES.map((f) => `${f.title} (${f.badge})`)).toEqual([
      "Open, play and practice (Available)",
      "Write tabs and scores (Available)",
      "Learning mode (Available)",
      "Audio to tab (AI · Beta)",
      "Record to tab (Beta)",
      "Speech to tab (AI · Coming soon)",
      "Hum to accompaniment (AI · Coming soon)",
    ]);
  });

  it("shows a card with the artwork, the status and the text for every feature", () => {
    renderWelcome();

    const list = within(screen.getByRole("region", { name: "Features" })).getAllByRole("list")[0]!;
    const cards = list.querySelectorAll(":scope > li");
    expect(cards).toHaveLength(FEATURES.length);
    for (const [index, feature] of FEATURES.entries()) {
      const card = within(cards[index] as HTMLElement);
      // The artwork carries the title, so the title is its text alternative (and a heading for screen readers).
      expect(card.getByRole("img", { name: feature.title })).toHaveAttribute("src");
      expect(card.getByRole("heading", { level: 3, name: feature.title })).toBeInTheDocument();
      expect(card.getByText(feature.badge)).toBeInTheDocument();
      expect(card.getByText(feature.description)).toBeInTheDocument();
    }
  });

  describe("Record to tab", () => {
    const findPopup = () =>
      waitFor(() => {
        const found = document.querySelector("[data-slot=hover-card-content]");
        expect(found).not.toBeNull();
        return found!;
      });
    const card = () => screen.getByRole("heading", { name: "Record to tab" }).closest("article")!;

    it("is a beta whose Limits button describes what it can't do yet", () => {
      renderWelcome();
      expect(within(card()).getByText("Beta")).toBeInTheDocument();
      const limits = within(card()).getByRole("button", { name: "Limits" });
      expect(limits).toHaveAccessibleDescription(/Guitar, bass, piano and drums\./);
      expect(limits).toHaveAccessibleDescription(/Guitar: roughly 7 of 10 notes are found/);
      expect(limits).toHaveAccessibleDescription(/Piano, built-in model: .* about 86%/);
      expect(limits).toHaveAccessibleDescription(/High accuracy model .* about 99%/);
      expect(limits).toHaveAccessibleDescription(/a real recording will score lower/);
      expect(limits).toHaveAccessibleDescription(/Drums: kick, snare and hi-hat/);
      expect(limits).toHaveAccessibleDescription(/correct it by hand/);
    });

    it("shows the limits in a popup when its button has focus", async () => {
      const { user } = renderWelcome();
      await user.tab();
      while (document.activeElement !== within(card()).getByRole("button", { name: "Limits" })) {
        await user.tab();
      }
      const popup = await findPopup();
      expect(popup).toHaveTextContent("No cloud AI");
      expect(popup).toHaveTextContent("use an existing recording");
    });

    it("shows the limits in a popup when hovering the Limits button itself", async () => {
      const { user } = renderWelcome();
      await user.hover(within(card()).getByRole("button", { name: "Limits" }));
      expect(await findPopup()).toHaveTextContent("Guitar, bass, piano and drums.");
    });

    it("shows the limits in a popup on hover", async () => {
      const { user } = renderWelcome();
      await user.hover(card());
      expect(await findPopup()).toHaveTextContent("Guitar, bass, piano and drums.");
    });
  });

  it("lists the tools of Learning mode", () => {
    renderWelcome();

    const card = screen.getByRole("heading", { name: "Learning mode" }).closest("article")!;
    expect(
      within(card)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Speed Trainer", "Loops", "Metronome", "Fretboard view", "Follow mode"]);
  });

  it("has the artwork of every feature, named after it", () => {
    // src/assets/features/<feature title as a file name>.png
    const names = FEATURES.map((f) =>
      f.title
        .toLowerCase()
        .replace(/[^a-z]+/g, "-")
        .replace(/^-|-$/g, ""),
    );
    expect(names).toEqual([
      "open-play-and-practice",
      "write-tabs-and-scores",
      "learning-mode",
      "audio-to-tab",
      "record-to-tab",
      "speech-to-tab",
      "hum-to-accompaniment",
    ]);
    for (const [index, feature] of FEATURES.entries()) {
      expect(feature.image).toContain(names[index]!);
    }
  });

  it("wires up the primary actions", async () => {
    const { user, onImportAudio, onOpenFile, onNewSong, onShowShortcuts } = renderWelcome();

    await user.click(screen.getByRole("button", { name: "Open a file…" }));
    await user.click(screen.getByRole("button", { name: "New song" }));
    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    await user.click(screen.getByRole("button", { name: "Import from Audio…" }));
    expect(onImportAudio).toHaveBeenCalledOnce();
    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onNewSong).toHaveBeenCalledOnce();
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations", async () => {
    renderWelcome();
    await expectNoA11yViolations();
  });
});

describe("Welcome: the tour", () => {
  const base = {
    onImportAudio: vi.fn(),
    onOpenFile: vi.fn(),
    onNewSong: vi.fn(),
    onShowShortcuts: vi.fn(),
  };

  it("offers the tour and wires Start and Skip", async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    const { user } = renderWithProviders(<Welcome {...base} tour={{ onStart, onSkip }} />);

    expect(
      screen.getByRole("heading", { name: "New here? Take a quick tour" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take a quick tour" }));
    expect(onStart).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledOnce();
    await expectNoA11yViolations();
  });

  it("has no tour offer without the tour prop", () => {
    renderWithProviders(<Welcome {...base} />);
    expect(screen.queryByText("New here? Take a quick tour")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();
  });

  it("has a Take a tour button, last, only when the tour can start", async () => {
    const onTakeTour = vi.fn();
    const { user, unmount } = renderWithProviders(<Welcome {...base} onTakeTour={onTakeTour} />);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf("Take a tour")).toBe(buttons.indexOf("Keyboard shortcuts") + 1);
    await user.click(screen.getByRole("button", { name: "Take a tour" }));
    expect(onTakeTour).toHaveBeenCalledOnce();
    unmount();

    renderWithProviders(<Welcome {...base} />);
    expect(screen.queryByRole("button", { name: "Take a tour" })).not.toBeInTheDocument();
  });
});

describe("Welcome: recent songs", () => {
  const recent = [
    "/Users/me/Songs/riff.gp5",
    "/Users/me/Songs/solo.gp",
    "C:\\Music\\tabs\\intro.gp4",
  ];

  it("shows nothing without recent songs", () => {
    renderWelcome();
    expect(screen.queryByRole("heading", { name: "Recent songs" })).not.toBeInTheDocument();
  });

  it("lists the recent songs with their folders and opens one", async () => {
    const onOpenRecent = vi.fn();
    const { user } = renderWithProviders(
      <Welcome
        onImportAudio={vi.fn()}
        onOpenFile={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        recent={recent}
        onOpenRecent={onOpenRecent}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Recent songs" })).toBeInTheDocument();
    const riff = screen.getByRole("button", { name: /riff\.gp5/ });
    expect(riff).toHaveTextContent("Songs");
    expect(screen.getByRole("button", { name: /intro\.gp4/ })).toHaveTextContent("tabs");
    await user.click(riff);
    expect(onOpenRecent).toHaveBeenCalledWith("/Users/me/Songs/riff.gp5");
  });

  it("has no accessibility violations", async () => {
    renderWithProviders(
      <Welcome
        onImportAudio={vi.fn()}
        onOpenFile={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        recent={recent}
        onOpenRecent={vi.fn()}
      />,
    );
    await expectNoA11yViolations();
  });
});

describe("Welcome: optional add-ons (#150)", () => {
  it("credits MuScriptor in a section of its own, as an add-on the user downloads", async () => {
    const { user } = renderWelcome();
    const section = screen
      .getByRole("heading", { name: "Add-ons you download yourself." })
      .closest("section")!;
    expect(within(section).getByRole("link", { name: "MuScriptor" })).toHaveAttribute(
      "href",
      "https://huggingface.co/MuScriptor",
    );
    expect(section).toHaveTextContent("Kyutai and Mirelo");
    expect(section).toHaveTextContent("CC BY-NC 4.0");
    expect(section).toHaveTextContent("Non-commercial use only");
    // Text only: no logos of the model's authors.
    expect(section.querySelector("img")).toBeNull();
    // The facts sit in a collapsed accordion.
    const trigger = within(section).getByRole("button", { name: "Powered by MuScriptor" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(within(section).getByRole("link", { name: "Online demo" })).toHaveAttribute(
      "href",
      "https://muscriptor.kyutai.org/",
    );
    expect(section).toHaveTextContent("not affiliated with or endorsed by Kyutai or Mirelo");
  });
});
