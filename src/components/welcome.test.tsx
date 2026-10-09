import { screen, within } from "@testing-library/react";

import { Welcome } from "@/components/welcome";
import { FEATURES } from "@/components/welcome-features";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function renderWelcome() {
  const onOpenFile = vi.fn();
  const onNewSong = vi.fn();
  const onShowShortcuts = vi.fn();
  const utils = renderWithProviders(
    <Welcome onOpenFile={onOpenFile} onNewSong={onNewSong} onShowShortcuts={onShowShortcuts} />,
  );
  return { ...utils, onOpenFile, onNewSong, onShowShortcuts };
}

describe("Welcome", () => {
  it("has one h1 and a logical heading order", () => {
    renderWelcome();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Features" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(FEATURES.length);
  });

  it("thanks alphaTab first, after the features, with its logo and links", () => {
    renderWelcome();

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[headings.length - 2]).toBe("Features");
    expect(headings[headings.length - 1]).toMatch(
      /^Many thanks to the open-source library maintainers/,
    );
    const section = screen
      .getByRole("heading", { name: /open-source library maintainers/ })
      .closest("section")!;
    const links = within(section).getAllByRole("link");
    expect(links[0]).toHaveAccessibleName("alphaTab");
    expect(links[0]).toHaveAttribute("href", "https://alphatab.net/");
    expect(within(section).getByRole("link", { name: "star alphaTab on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/CoderLine/alphaTab",
    );
    expect(section).toHaveTextContent("not affiliated with or endorsed by alphaTab");
    expect(links).toHaveLength(2 + 4);
    expect(within(section).getByRole("link", { name: "rustysynth" })).toBeInTheDocument();
    expect(within(section).queryByRole("link", { name: "React" })).not.toBeInTheDocument();
  });

  it("orders the features: what works first, the AI ideas last, Hum to accompaniment at the end", () => {
    expect(FEATURES.map((f) => `${f.title} (${f.badge})`)).toEqual([
      "Open, play and practice (Available)",
      "Write tabs and scores (Available)",
      "Learning mode (Available)",
      "Audio to tab (Available)",
      "Record to tab (AI · Coming soon)",
      "Speech to tab (AI · Coming soon)",
      "Hum to accompaniment (AI · Coming soon)",
    ]);
  });

  it("lists every upcoming feature", () => {
    renderWelcome();

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(FEATURES.length);
    for (const feature of FEATURES) {
      expect(within(list).getByRole("heading", { name: feature.title })).toBeInTheDocument();
    }
  });

  it("wires up the primary actions", async () => {
    const { user, onOpenFile, onNewSong, onShowShortcuts } = renderWelcome();

    await user.click(screen.getByRole("button", { name: "Open a file…" }));
    await user.click(screen.getByRole("button", { name: "New song" }));
    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(onOpenFile).toHaveBeenCalledOnce();
    expect(onNewSong).toHaveBeenCalledOnce();
    expect(onShowShortcuts).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations", async () => {
    renderWelcome();
    await expectNoA11yViolations();
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
