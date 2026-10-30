import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";

import { StemDialog } from "@/components/stems/stem-dialog";
import { isEnabled } from "@/lib/features";
import { STEMS_STOPPED, type SeparateRequest } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri, STEM_SONG, UMX_STATUS, type IpcCall } from "@/test/tauri";

vi.mock("@/lib/features", () => ({ isEnabled: vi.fn(() => false) }));

const SONG_PATH = "/Users/me/Music/neon-nights.mp3";

type Props = ComponentProps<typeof StemDialog>;

function setup(props: Partial<Props> = {}, overrides: Parameters<typeof mockTauri>[0] = {}) {
  const calls = mockTauri(overrides);
  const onOpenChange = vi.fn();
  const onSeparated = vi.fn();
  const base: Props = { open: true, onOpenChange, onSeparated, ...props };
  const ui = renderWithProviders(<StemDialog {...base} />);
  const update = (changes: Partial<Props>) => ui.rerender(<StemDialog {...base} {...changes} />);
  return { ...ui, calls, onOpenChange, onSeparated, update };
}

const dialog = () => screen.getByRole("dialog", { name: "Stem separation" });

/** Chooses SONG_PATH through the native dialog and goes to the options. */
async function toOptions(user: ReturnType<typeof setup>["user"], path = SONG_PATH) {
  backend.dialogResult = path;
  await user.click(screen.getByRole("button", { name: "Choose a song…" }));
  await screen.findByTestId("stem-file-name");
  await user.click(screen.getByRole("button", { name: "Next" }));
}

const request = (calls: IpcCall[]) =>
  (calls.find((call) => call.cmd === "stems_separate")!.args as { request: SeparateRequest })
    .request;

/** A `stems_separate` that finishes when the test says so. */
function heldSeparation() {
  let finish!: (result: unknown) => void;
  let fail!: (error: unknown) => void;
  const handler = () =>
    new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  return {
    handler,
    finish: (value: unknown = STEM_SONG) => finish(value),
    fail: (e: unknown) => fail(e),
  };
}

beforeEach(() => vi.mocked(isEnabled).mockReturnValue(false));

describe("Stem separation dialog: step 1, the song", () => {
  it("says that nothing leaves the computer and waits for a song", () => {
    setup();
    expect(within(dialog()).getByText("Runs on this computer. Nothing is uploaded.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Stem separation" })).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent(
      /Song.*Options.*Separate/,
    );
  });

  it("shows the chosen song and lets it be replaced or removed", async () => {
    const { user } = setup();
    backend.dialogResult = SONG_PATH;
    await user.click(screen.getByRole("button", { name: "Choose a song…" }));
    expect(await screen.findByTestId("stem-file-name")).toHaveTextContent("neon-nights.mp3");
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose another song…" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove song" }));
    expect(screen.queryByTestId("stem-file-name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("keeps the dialog as it is when the native dialog is cancelled", async () => {
    const { user } = setup();
    backend.dialogResult = null;
    await user.click(screen.getByRole("button", { name: "Choose a song…" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses a file that is not audio", async () => {
    const { user } = setup();
    backend.dialogResult = "/Users/me/Documents/notes.pdf";
    await user.click(screen.getByRole("button", { name: "Choose a song…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose MP3, WAV, FLAC, OGG or AIFF",
    );
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("takes a song dropped on the window, once per drop", async () => {
    const { update } = setup();
    update({ droppedSong: { path: SONG_PATH, nonce: 1 } });
    expect(await screen.findByTestId("stem-file-name")).toHaveTextContent("neon-nights.mp3");
    update({ droppedSong: { path: "/Music/other.flac", nonce: 2 } });
    await waitFor(() =>
      expect(screen.getByTestId("stem-file-name")).toHaveTextContent("other.flac"),
    );
    update({ droppedSong: { path: "/Music/readme.txt", nonce: 3 } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose MP3");
    // The earlier song is still the chosen one.
    expect(screen.getByTestId("stem-file-name")).toHaveTextContent("other.flac");
  });

  it("closes with Close", async () => {
    const { user, onOpenChange } = setup();
    const footer = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.dataset.slot !== "dialog-close")!;
    await user.click(footer);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says it needs the desktop app in a browser", () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    renderWithProviders(<StemDialog open onOpenChange={vi.fn()} onSeparated={vi.fn()} />);
    expect(screen.getByText("Stem separation is available in the desktop app.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});

describe("Stem separation dialog: step 2, the options", () => {
  it("lists the parts, with Other always on and marked as not separated", async () => {
    const { user } = setup();
    await toOptions(user);
    const parts = within(screen.getByRole("group", { name: "Parts to separate" }));
    for (const name of ["Drums", "Bass", "Vocals", "Guitars and keys (panned parts)"]) {
      expect(
        parts.getByRole("checkbox", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) }),
      ).toBeChecked();
    }
    const other = parts.getByRole("checkbox", { name: "Other, not separated" });
    expect(other).toBeChecked();
    expect(other).toBeDisabled();
    expect(parts.getByText(/· not separated/)).toBeInTheDocument();
    // A fixed list: nothing says the app detects instruments.
    expect(screen.getByText(/does not guess which instruments/)).toBeInTheDocument();
  });

  it("offers Gentle or Strong drum removal while drums are chosen", async () => {
    const { user } = setup();
    await toOptions(user);
    const group = screen.getByRole("radiogroup", { name: "Drum removal" });
    expect(within(group).getByRole("radio", { name: "Gentle" })).toBeChecked();
    expect(screen.getByText(/Keeps the other parts clean/)).toBeInTheDocument();
    await user.click(within(group).getByRole("radio", { name: "Strong" }));
    expect(screen.getByText(/about twice as far/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /^Drums/ }));
    expect(screen.queryByRole("radiogroup", { name: "Drum removal" })).not.toBeInTheDocument();
  });

  it("cannot separate with no part chosen", async () => {
    const { user } = setup();
    await toOptions(user);
    for (const name of [/^Drums/, /^Bass/, /^Vocals/, /^Guitars and keys/]) {
      await user.click(screen.getByRole("checkbox", { name }));
    }
    expect(screen.getByRole("button", { name: "Separate" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /^Bass/ }));
    expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled();
  });

  it("goes back to the song", async () => {
    const { user } = setup();
    await toOptions(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("stem-file-name")).toBeInTheDocument();
  });

  it("has no engine choice while the neural flag is off", async () => {
    const { user } = setup();
    await toOptions(user);
    expect(screen.queryByRole("radiogroup", { name: "Engine" })).not.toBeInTheDocument();
    expect(screen.queryByText(/neural/i)).not.toBeInTheDocument();
  });
});

describe("Stem separation dialog: step 3, the job", () => {
  it("sends the choices, shows the progress and hands over the song", async () => {
    const job = heldSeparation();
    const { user, calls, onSeparated } = setup({}, { stems_separate: job.handler });
    await toOptions(user);
    await user.click(screen.getByRole("checkbox", { name: /^Guitars and keys/ }));
    await user.click(
      within(screen.getByRole("radiogroup", { name: "Drum removal" })).getByRole("radio", {
        name: "Strong",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Separate" }));

    expect(request(calls)).toEqual({
      path: SONG_PATH,
      kinds: ["drums", "bass", "vocals"],
      engine: "fast",
      strongDrums: true,
    });
    const bar = await screen.findByRole("progressbar", { name: "Separation progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    await act(() => emit("stems-progress", { stage: "separating", fraction: 0.5 }));
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
    expect(screen.getByText(/Separating the parts/)).toHaveTextContent("(in progress)");
    expect(screen.getByText(/Reading the song/)).toHaveTextContent("(done)");

    await act(async () => job.finish());
    await waitFor(() => expect(onSeparated).toHaveBeenCalledWith(STEM_SONG));
  });

  it("stops on Cancel and returns to the options without an error", async () => {
    const job = heldSeparation();
    const { user, calls } = setup({}, { stems_separate: job.handler });
    await toOptions(user);
    await user.click(screen.getByRole("button", { name: "Separate" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.some((call) => call.cmd === "stems_cancel")).toBe(true);
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();

    await act(async () => job.fail({ kind: "audio", message: STEMS_STOPPED }));
    expect(await screen.findByRole("button", { name: "Separate" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows why it failed and keeps the choices", async () => {
    const { user } = setup(
      {},
      {
        stems_separate: () => {
          throw { kind: "audio", message: "The file could not be decoded." };
        },
      },
    );
    await toOptions(user);
    await user.click(screen.getByRole("checkbox", { name: /^Bass/ }));
    await user.click(screen.getByRole("button", { name: "Separate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file could not be decoded.");
    expect(screen.getByRole("checkbox", { name: /^Bass/ })).not.toBeChecked();
  });

  it("stops the job when the dialog is closed while it runs", async () => {
    const job = heldSeparation();
    const { user, calls, update } = setup({}, { stems_separate: job.handler });
    await toOptions(user);
    await user.click(screen.getByRole("button", { name: "Separate" }));
    await screen.findByRole("progressbar");
    update({ open: false });
    await waitFor(() => expect(calls.some((call) => call.cmd === "stems_cancel")).toBe(true));
  });
});

describe("Stem separation dialog: the neural engine", () => {
  beforeEach(() =>
    vi.mocked(isEnabled).mockImplementation((id) => id === "stem-separation-neural"),
  );

  async function openNeural(user: ReturnType<typeof setup>["user"]) {
    await toOptions(user);
    await user.click(screen.getByRole("radio", { name: "Neural" }));
  }

  it("offers an engine choice, with Fast first and chosen", async () => {
    const { user } = setup();
    await toOptions(user);
    const group = screen.getByRole("radiogroup", { name: "Engine" });
    expect(within(group).getByRole("radio", { name: "Fast" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Neural" })).not.toBeChecked();
  });

  it("needs the download first and keeps Separate off until it is done", async () => {
    const { user } = setup();
    await openNeural(user);
    expect(await screen.findByText(/one-time download of 136 MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Separate" })).toBeDisabled();
    expect(screen.getByText(/The neural engine separates/)).toHaveTextContent(
      "drums, bass, vocals and other",
    );
    expect(screen.queryByRole("group", { name: "Parts to separate" })).not.toBeInTheDocument();
  });

  it("shows the terms, wants the rights confirmed, then downloads with progress", async () => {
    let release!: () => void;
    const { user, calls } = setup(
      {},
      {
        umx_model_download: async () => {
          await emit("umx-model-download-progress", { downloadedBytes: 50, totalBytes: 100 });
          await new Promise<void>((resolve) => (release = resolve));
          backend.umx.downloaded = true;
          return null;
        },
      },
    );
    await openNeural(user);
    await user.click(await screen.findByRole("button", { name: "Download the neural model…" }));
    const setupPanel = screen.getByTestId("stem-neural-setup");
    expect(setupPanel).toHaveTextContent("trained on MUSDB18-HQ");
    const accept = within(setupPanel).getByRole("button", { name: "Accept and download" });
    expect(accept).toBeDisabled();
    await user.click(
      within(setupPanel).getByRole("checkbox", { name: /I only use music I have the rights to/ }),
    );
    await user.click(accept);

    expect(calls.map((call) => call.cmd)).toContain("umx_model_accept_terms");
    const bar = await screen.findByRole("progressbar", { name: "Download progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeEnabled();

    await act(async () => release());
    // The model is on this computer: Separate is on, with the neural request.
    await waitFor(() => expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled());
    expect(screen.getByText(/neural model is on this computer/)).toBeInTheDocument();
  });

  it("stops a download and goes back to the terms without an error", async () => {
    let stop!: (error: unknown) => void;
    const { user, calls } = setup(
      {},
      { umx_model_download: () => new Promise((_resolve, reject) => (stop = reject)) },
    );
    await openNeural(user);
    await user.click(await screen.findByRole("button", { name: "Download the neural model…" }));
    await user.click(screen.getByRole("checkbox", { name: /I only use music/ }));
    await user.click(screen.getByRole("button", { name: "Accept and download" }));
    await user.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(calls.some((call) => call.cmd === "umx_model_cancel")).toBe(true);
    await act(async () => stop({ kind: "audio", message: "Download stopped." }));
    expect(await screen.findByRole("button", { name: "Accept and download" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a download error", async () => {
    const { user } = setup(
      {},
      {
        umx_model_download: () => {
          throw { kind: "network", message: "The download failed: no connection." };
        },
      },
    );
    await openNeural(user);
    await user.click(await screen.findByRole("button", { name: "Download the neural model…" }));
    await user.click(screen.getByRole("checkbox", { name: /I only use music/ }));
    await user.click(screen.getByRole("button", { name: "Accept and download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The download failed");
  });

  it("separates with the neural engine once the model is ready", async () => {
    const job = heldSeparation();
    const { user, calls } = setup(
      {},
      {
        stems_separate: job.handler,
        umx_model_status: () => ({ ...UMX_STATUS, downloaded: true, termsAccepted: true }),
      },
    );
    await openNeural(user);
    await waitFor(() => expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Separate" }));
    expect(request(calls)).toEqual({
      path: SONG_PATH,
      kinds: ["drums", "bass", "vocals"],
      engine: "neural",
      strongDrums: false,
    });
  });
});

describe("Stem separation dialog: accessibility", () => {
  it("has no violations on the song and options steps", async () => {
    const { user } = setup();
    await expectNoA11yViolations(dialog());
    await toOptions(user);
    await expectNoA11yViolations(dialog());
  });

  it("has no violations while it runs", async () => {
    const job = heldSeparation();
    const { user } = setup({}, { stems_separate: job.handler });
    await toOptions(user);
    await user.click(screen.getByRole("button", { name: "Separate" }));
    await screen.findByRole("progressbar");
    await expectNoA11yViolations(dialog());
  });
});
