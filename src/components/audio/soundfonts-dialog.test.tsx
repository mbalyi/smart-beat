import { act, screen, within } from "@testing-library/react";

import { SoundFontsDialog } from "@/components/audio/soundfonts-dialog";
import { soundFontFromStored } from "@/lib/score/soundfonts";
import type {
  SoundFontCatalogueItem,
  SoundFontDownloadProgress,
  StoredSoundFont,
} from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const CATALOGUE: SoundFontCatalogueItem[] = [
  {
    id: "musescore-general",
    name: "MuseScore General",
    description: "A large General MIDI bank.",
    licence: "MIT",
    personalUseOnly: false,
    page: "https://musescore.org/en/handbook/3/soundfonts-and-sfz-files",
    downloadBytes: 39_900_972,
    bytes: 39_900_972,
    installed: false,
  },
  {
    id: "arachno",
    name: "Arachno",
    description: "A full-size General MIDI bank.",
    licence: "Free for personal use only. Do not redistribute.",
    personalUseOnly: true,
    page: "http://www.arachnosoft.com/main/download.php?id=soundfont-sf2",
    downloadBytes: 143_356_181,
    bytes: 155_405_818,
    installed: false,
  },
];

const IMPORTED: StoredSoundFont = {
  id: "my-bank",
  name: "My Bank",
  file: "my-bank.sf2",
  bytes: 32_319_396,
  catalogue: null,
};

const DOWNLOADED: StoredSoundFont = {
  id: "musescore-general",
  name: "MuseScore General",
  file: "MuseScore_General.sf3",
  bytes: 39_900_972,
  catalogue: "musescore-general",
};

function setup({
  stored = [] as StoredSoundFont[],
  catalogue = CATALOGUE,
  available = true,
  activeId = "sonivox",
  onDownload = vi.fn(
    async (
      _id: string,
      _onProgress: (progress: SoundFontDownloadProgress) => void,
    ): Promise<StoredSoundFont | null> => DOWNLOADED,
  ),
  onImport = vi.fn(async (_path: string) => IMPORTED),
  onPick = vi.fn(async () => "/music/My Bank.sf2" as string | null),
} = {}) {
  const onRemove = vi.fn(async (_id: string) => true);
  const onCancelDownload = vi.fn(async () => {});
  const utils = renderWithProviders(
    <SoundFontsDialog
      open
      onOpenChange={vi.fn()}
      fonts={stored.map(soundFontFromStored)}
      stored={stored}
      catalogue={catalogue.map((item) => ({
        ...item,
        installed: stored.some((s) => s.catalogue === item.id),
      }))}
      available={available}
      activeId={activeId}
      onPick={onPick}
      onImport={onImport}
      onDownload={onDownload}
      onCancelDownload={onCancelDownload}
      onRemove={onRemove}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "SoundFonts" });
  return { ...utils, dialog, onDownload, onImport, onPick, onRemove, onCancelDownload };
}

describe("SoundFontsDialog (#81)", () => {
  it("lists the recommended banks with description, size, licence and source", async () => {
    const { dialog } = setup();
    const [muse, arachno] = within(dialog).getAllByTestId("catalogue-soundfont");
    expect(muse).toHaveTextContent("MuseScore General");
    expect(muse).toHaveTextContent("A large General MIDI bank.");
    expect(muse).toHaveTextContent("40 MB");
    expect(muse).toHaveTextContent("MIT");
    expect(muse).toHaveTextContent("Source: musescore.org");
    expect(arachno).toHaveTextContent("Personal use only");
    expect(arachno).toHaveTextContent("Free for personal use only. Do not redistribute.");
    expect(arachno).toHaveTextContent("Download: 143 MB");
    await expectNoA11yViolations();
  });

  it("downloads a bank and shows the progress", async () => {
    let report: (progress: SoundFontDownloadProgress) => void = () => {};
    let finish: (font: StoredSoundFont | null) => void = () => {};
    const onDownload = vi.fn(
      (_id: string, onProgress: (progress: SoundFontDownloadProgress) => void) => {
        report = onProgress;
        return new Promise<StoredSoundFont | null>((resolve) => (finish = resolve));
      },
    );
    const { user, dialog, onCancelDownload } = setup({ onDownload });

    await user.click(within(dialog).getByRole("button", { name: "Download MuseScore General" }));
    expect(onDownload).toHaveBeenCalledWith("musescore-general", expect.any(Function));

    act(() => report({ id: "musescore-general", fraction: 0.42, unpacking: false }));
    const bar = within(dialog).getByRole("progressbar", { name: "Downloading MuseScore General" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(dialog).toHaveTextContent("Downloading… 42%");
    // One download at a time; the others wait.
    expect(within(dialog).getByRole("button", { name: "Download Arachno" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Import a SoundFont…" })).toBeDisabled();
    await expectNoA11yViolations();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onCancelDownload).toHaveBeenCalled();

    act(() => report({ id: "musescore-general", fraction: 1, unpacking: true }));
    expect(dialog).toHaveTextContent("Unpacking…");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => finish(null)); // cancelled: nothing is shown
    expect(within(dialog).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Download Arachno" })).toBeEnabled();
  });

  it("shows why a download failed and lets the user try again", async () => {
    const onDownload = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("The downloaded file is not the expected one. Try again later."),
      );
    const { user, dialog } = setup({ onDownload });

    await user.click(within(dialog).getByRole("button", { name: "Download Arachno" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("not the expected one");
    expect(within(dialog).getByRole("button", { name: "Download Arachno" })).toBeEnabled();
  });

  it("marks a downloaded bank as installed and removes it after a confirmation", async () => {
    const { user, dialog, onRemove } = setup({ stored: [DOWNLOADED] });
    const [muse] = within(dialog).getAllByTestId("catalogue-soundfont");
    expect(muse).toHaveTextContent("Installed");
    expect(within(muse!).queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();

    await user.click(within(muse!).getByRole("button", { name: "Remove MuseScore General" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(muse).toHaveTextContent("Delete this file?");

    await user.click(within(muse!).getByRole("button", { name: "Keep" }));
    expect(onRemove).not.toHaveBeenCalled();

    await user.click(within(muse!).getByRole("button", { name: "Remove MuseScore General" }));
    await user.click(within(muse!).getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith("musescore-general");
  });

  it("imports a file from the computer and lists the ones imported", async () => {
    const { user, dialog, onPick, onImport } = setup({ stored: [IMPORTED] });
    const row = within(dialog).getByTestId("imported-soundfont");
    expect(row).toHaveTextContent("My Bank");
    expect(row).toHaveTextContent("32 MB");

    await user.click(within(dialog).getByRole("button", { name: "Import a SoundFont…" }));
    expect(onPick).toHaveBeenCalled();
    expect(onImport).toHaveBeenCalledWith("/music/My Bank.sf2");
  });

  it("does nothing when the file picker is cancelled", async () => {
    const { user, dialog, onImport } = setup({ onPick: vi.fn(async () => null) });
    await user.click(within(dialog).getByRole("button", { name: "Import a SoundFont…" }));
    expect(onImport).not.toHaveBeenCalled();
  });

  it("shows the reason when a file cannot be imported", async () => {
    const onImport = vi
      .fn()
      .mockRejectedValue(new Error("Choose a SoundFont file (.sf2 or .sf3)."));
    const { user, dialog } = setup({ onImport });
    await user.click(within(dialog).getByRole("button", { name: "Import a SoundFont…" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Choose a SoundFont file");
  });

  it("removes an imported file after a confirmation and says when it is in use", async () => {
    const { user, dialog, onRemove } = setup({ stored: [IMPORTED], activeId: "stored:my-bank" });
    const row = within(dialog).getByTestId("imported-soundfont");

    await user.click(within(row).getByRole("button", { name: "Remove My Bank" }));
    expect(row).toHaveTextContent("In use. Playback switches to Standard.");
    await user.click(within(row).getByRole("button", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledWith("my-bank");
  });

  it("says that adding SoundFonts needs the desktop app in a browser", async () => {
    const { dialog } = setup({ available: false });
    expect(dialog).toHaveTextContent("available in the Smart Beat desktop app");
    expect(within(dialog).getByRole("button", { name: "Import a SoundFont…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Download Arachno" })).toBeDisabled();
  });

  it("has no accessibility violations with banks added", async () => {
    setup({ stored: [DOWNLOADED, IMPORTED] });
    await expectNoA11yViolations();
  });
});
