import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";

import { StemDialog } from "@/components/stems/stem-dialog";
import { isEnabled } from "@/lib/features";
import { STEMS_STOPPED, type SeparateRequest } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import {
  backend,
  mockTauri,
  STEM_SONG,
  stemModelStatus,
  UMX_STATUS,
  type IpcCall,
} from "@/test/tauri";

vi.mock("@/lib/features", () => ({ isEnabled: vi.fn(() => false) }));

const SONG_PATH = "/Users/me/Music/neon-nights.mp3";

type Props = ComponentProps<typeof StemDialog>;

/** `seed` changes the mocked backend, which `mockTauri` resets, before the dialog renders. */
function setup(
  props: Partial<Props> = {},
  overrides: Parameters<typeof mockTauri>[0] = {},
  seed?: () => void,
) {
  const calls = mockTauri(overrides);
  seed?.();
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
  await user.click(screen.getByRole("button", { name: "Choose a song" }));
  await screen.findByTestId("stem-file-name");
  await user.click(screen.getByRole("button", { name: "Next" }));
}

/** The options step with the engine `name` chosen (the neural flag has to be on). */
async function openEngine(user: ReturnType<typeof setup>["user"], name: string) {
  await toOptions(user);
  await user.click(screen.getByRole("radio", { name }));
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
    await user.click(screen.getByRole("button", { name: "Choose a song" }));
    expect(await screen.findByTestId("stem-file-name")).toHaveTextContent("neon-nights.mp3");
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Choose another song" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove song" }));
    expect(screen.queryByTestId("stem-file-name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("keeps the dialog as it is when the native dialog is cancelled", async () => {
    const { user } = setup();
    backend.dialogResult = null;
    await user.click(screen.getByRole("button", { name: "Choose a song" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refuses a file that is not audio", async () => {
    const { user } = setup();
    backend.dialogResult = "/Users/me/Documents/notes.pdf";
    await user.click(screen.getByRole("button", { name: "Choose a song" }));
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
    expect(screen.queryByText(/neural|HTDemucs|SCNet|UMX/i)).not.toBeInTheDocument();
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

describe("Stem separation dialog: the engines", () => {
  beforeEach(() =>
    vi.mocked(isEnabled).mockImplementation((id) => id === "stem-separation-neural"),
  );

  it("lists the engines as cards, with Fast first and HTDemucs chosen", async () => {
    const { user } = setup();
    await toOptions(user);
    const group = screen.getByRole("radiogroup", { name: "Engine" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "fast",
      "htdemucs",
      "htdemucs-6s",
      "scnet-xl",
      "scnet",
      "neural",
    ]);
    expect(within(group).getByRole("radio", { name: "HTDemucs" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Fast" })).not.toBeChecked();
    expect(within(group).getByRole("radio", { name: "UMX-HQ" })).not.toBeChecked();
  });

  it("says what each model is best at, and recommends HTDemucs", async () => {
    const { user } = setup();
    await toOptions(user);
    const card = (name: string) => screen.getByRole("radio", { name }).closest("[data-engine]")!;
    expect(card("HTDemucs")).toHaveTextContent("Recommended");
    expect(card("HTDemucs")).toHaveTextContent("Best all-round choice");
    expect(card("SCNet XL")).toHaveTextContent("Best for vocals");
    expect(card("SCNet XL")).toHaveTextContent("a 4-minute song takes about 27 minutes");
    expect(card("SCNet Small")).toHaveTextContent("lightest of the new models");
    expect(card("UMX-HQ")).toHaveTextContent("better on drums and bass");
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "HTDemucs" })).toHaveAccessibleDescription(
      /Recommended.*Best all-round choice/,
    );
  });

  it("shows where each model stands on its card", async () => {
    const { user } = setup({}, {}, () => {
      backend.stemModels["scnet-xl"].available = false;
      backend.stemModels.scnet.downloaded = true;
      backend.stemModels.scnet.termsAccepted = true;
    });
    await toOptions(user);
    const card = (name: string) => screen.getByRole("radio", { name }).closest("[data-engine]")!;
    await waitFor(() => expect(card("HTDemucs")).toHaveTextContent("Download 168 MB"));
    expect(card("SCNet Small")).toHaveTextContent("On this computer");
    expect(card("SCNet XL")).toHaveTextContent("Not published yet");
    expect(card("UMX-HQ")).toHaveTextContent("Download 136 MB");
    expect(card("Fast")).toHaveTextContent("Built in");
  });

  it("needs the download first and keeps Separate off until it is done", async () => {
    const { user } = setup();
    await openEngine(user, "UMX-HQ");
    expect(await screen.findByText(/one-time download of 136 MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Separate" })).toBeDisabled();
    expect(screen.getByText(/UMX-HQ separates/)).toHaveTextContent("drums, bass, vocals and other");
    expect(screen.queryByRole("group", { name: "Parts to separate" })).not.toBeInTheDocument();
  });

  it("shows the terms, wants the rights confirmed, then downloads UMX-HQ with progress", async () => {
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
    await openEngine(user, "UMX-HQ");
    await user.click(await screen.findByRole("button", { name: "Download UMX-HQ" }));
    const setupPanel = screen.getByTestId("stem-neural-setup");
    expect(setupPanel).toHaveTextContent("Terms of UMX-HQ");
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
    // The model is on this computer: Separate is on.
    await waitFor(() => expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled());
    expect(screen.getByText("UMX-HQ is on this computer.")).toBeInTheDocument();
  });

  it("downloads HTDemucs through the model commands, with its own progress", async () => {
    let release!: () => void;
    const { user, calls } = setup(
      {},
      {
        stem_model_download: async () => {
          // Another model's progress is not this download's.
          await emit("stem-model-download-progress", {
            model: "scnet",
            downloadedBytes: 90,
            totalBytes: 100,
          });
          await emit("stem-model-download-progress", {
            model: "htdemucs",
            downloadedBytes: 25,
            totalBytes: 100,
          });
          await new Promise<void>((resolve) => (release = resolve));
          backend.stemModels.htdemucs.downloaded = true;
          return null;
        },
      },
    );
    await openEngine(user, "HTDemucs");
    expect(await screen.findByText(/one-time download of 168 MB/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download HTDemucs" }));
    const setupPanel = screen.getByTestId("stem-neural-setup");
    expect(setupPanel).toHaveTextContent("Terms of HTDemucs");
    expect(setupPanel).toHaveTextContent("The terms of htdemucs");
    await user.click(within(setupPanel).getByRole("checkbox", { name: /I only use music/ }));
    await user.click(within(setupPanel).getByRole("button", { name: "Accept and download" }));

    expect(calls).toContainEqual({ cmd: "stem_model_accept_terms", args: { model: "htdemucs" } });
    expect(calls).toContainEqual({ cmd: "stem_model_download", args: { model: "htdemucs" } });
    const bar = await screen.findByRole("progressbar", { name: "Download progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "25"));
    expect(screen.getByText("Downloading HTDemucs…")).toBeInTheDocument();

    await act(async () => release());
    await waitFor(() => expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled());
    expect(screen.getByText("HTDemucs is on this computer.")).toBeInTheDocument();
  });

  it("stops a download and goes back to the terms without an error", async () => {
    let stop!: (error: unknown) => void;
    const { user, calls } = setup(
      {},
      { stem_model_download: () => new Promise((_resolve, reject) => (stop = reject)) },
    );
    await openEngine(user, "SCNet XL");
    await user.click(await screen.findByRole("button", { name: "Download SCNet XL" }));
    await user.click(screen.getByRole("checkbox", { name: /I only use music/ }));
    await user.click(screen.getByRole("button", { name: "Accept and download" }));
    await user.click(await screen.findByRole("button", { name: "Cancel download" }));
    expect(calls.some((call) => call.cmd === "stem_model_cancel")).toBe(true);
    await act(async () => stop({ kind: "audio", message: "Download stopped." }));
    expect(await screen.findByRole("button", { name: "Accept and download" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a download error", async () => {
    const { user } = setup(
      {},
      {
        stem_model_download: () => {
          throw { kind: "network", message: "The download failed: no connection." };
        },
      },
    );
    await openEngine(user, "SCNet Small");
    await user.click(await screen.findByRole("button", { name: "Download SCNet Small" }));
    await user.click(screen.getByRole("checkbox", { name: /I only use music/ }));
    await user.click(screen.getByRole("button", { name: "Accept and download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The download failed");
  });

  it("cannot download a model that is not published yet", async () => {
    const { user, calls } = setup({}, {}, () => {
      backend.stemModels["scnet-xl"].available = false;
    });
    await openEngine(user, "SCNet XL");
    expect(await screen.findByText(/SCNet XL is not published yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download SCNet XL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Separate" })).toBeDisabled();
    expect(calls.some((call) => call.cmd === "stem_model_download")).toBe(false);
  });

  it("says when a model's status cannot be read", async () => {
    const { user } = setup(
      {},
      {
        stem_model_status: () => {
          throw { kind: "io", message: "No data folder." };
        },
      },
    );
    await openEngine(user, "HTDemucs");
    expect(await screen.findByRole("status")).toHaveTextContent("No data folder.");
    expect(screen.getByRole("button", { name: "Separate" })).toBeDisabled();
  });

  describe("deleting a model from its card", () => {
    const onComputer =
      (...models: Array<"scnet" | "scnet-xl" | "htdemucs" | "htdemucs-6s">) =>
      () => {
        for (const model of models) {
          backend.stemModels[model].downloaded = true;
          backend.stemModels[model].termsAccepted = true;
        }
      };
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-engine="${id}"]`)!;

    it("puts Delete under 'On this computer', only on models that are there", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs"));
      await toOptions(user);
      const htdemucs = card("htdemucs");
      await within(htdemucs).findByText("On this computer");
      expect(
        within(htdemucs).getByRole("button", { name: "Delete the HTDemucs model" }),
      ).toBeEnabled();
      expect(screen.getAllByRole("button", { name: /^Delete the / })).toHaveLength(1);
      expect(within(card("fast")).queryByRole("button", { name: /Delete/ })).toBeNull();
      expect(within(card("scnet")).queryByRole("button", { name: /Delete/ })).toBeNull();
    });

    it("offers the 6-part engine as this build hosts it: its size, its terms and Delete", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs-6s"));
      await toOptions(user);
      const sixPart = await screen.findByRole("radio", { name: "HTDemucs 6-part" });
      await waitFor(() =>
        expect(sixPart.closest("[data-engine]")).toHaveTextContent("On this computer"),
      );
      await user.click(sixPart);
      expect(
        within(card("htdemucs-6s")).getByRole("button", {
          name: "Delete the HTDemucs 6-part model",
        }),
      ).toBeEnabled();
    });

    it("shows the 6-part download size and its terms when it is not there yet", async () => {
      const { user } = setup();
      await toOptions(user);
      await waitFor(() => expect(card("htdemucs-6s")).toHaveTextContent("Download 111 MB"));
      await user.click(screen.getByRole("radio", { name: "HTDemucs 6-part" }));
      await user.click(screen.getByRole("button", { name: "Download HTDemucs 6-part" }));
      expect(screen.getByTestId("stem-neural-setup")).toHaveTextContent("Terms of HTDemucs 6-part");
    });

    it("asks for a second click, and Keep backs out", async () => {
      const { user, calls } = setup({}, {}, onComputer("htdemucs"));
      await toOptions(user);
      const first = await screen.findByRole("button", { name: "Delete the HTDemucs model" });
      await user.click(first);
      expect(calls.some((call) => call.cmd === "stem_model_remove")).toBe(false);
      await user.click(screen.getByRole("button", { name: "Keep" }));
      expect(screen.getByRole("button", { name: "Delete the HTDemucs model" })).toBeInTheDocument();
      expect(calls.some((call) => call.cmd === "stem_model_remove")).toBe(false);

      await user.click(screen.getByRole("button", { name: "Delete the HTDemucs model" }));
      await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
      expect(calls).toContainEqual({ cmd: "stem_model_remove", args: { model: "htdemucs" } });
      await within(card("htdemucs")).findByText("Download 168 MB");
      expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    });

    it("does not choose the engine when Delete is clicked on another card", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs", "scnet"));
      await toOptions(user);
      await user.click(await screen.findByRole("button", { name: "Delete the SCNet Small model" }));
      expect(screen.getByRole("radio", { name: "HTDemucs" })).toBeChecked();
      expect(screen.getByRole("radio", { name: "SCNet Small" })).not.toBeChecked();
    });

    it("moves the choice to the next model that is on this computer", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs", "scnet"));
      await toOptions(user);
      expect(screen.getByRole("radio", { name: "HTDemucs" })).toBeChecked();
      await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
      await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
      await waitFor(() => expect(screen.getByRole("radio", { name: "SCNet Small" })).toBeChecked());
      expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled();
    });

    it("moves the choice to Fast when no model is left", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs"));
      await toOptions(user);
      await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
      await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
      await waitFor(() => expect(screen.getByRole("radio", { name: "Fast" })).toBeChecked());
      expect(screen.getByRole("group", { name: "Parts to separate" })).toBeInTheDocument();
    });

    it("keeps the choice when another model is deleted", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs", "scnet"));
      await toOptions(user);
      await user.click(await screen.findByRole("button", { name: "Delete the SCNet Small model" }));
      await user.click(screen.getByRole("button", { name: "Delete SCNet Small" }));
      await within(card("scnet")).findByText("Download 50 MB");
      expect(screen.getByRole("radio", { name: "HTDemucs" })).toBeChecked();
    });

    it("keeps every Delete off while one delete is under way", async () => {
      let finish!: () => void;
      const { user } = setup(
        {},
        {
          stem_model_remove: () =>
            new Promise((resolve) => {
              finish = () => resolve(null);
            }),
        },
        onComputer("htdemucs", "scnet"),
      );
      await toOptions(user);
      await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
      await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
      const other = await screen.findByRole("button", { name: "Delete the SCNet Small model" });
      await waitFor(() => expect(other).toBeDisabled());
      finish();
      await waitFor(() => expect(other).toBeEnabled());
    });

    it("says why when the app refuses, and keeps the model", async () => {
      const { user } = setup(
        {},
        {
          stem_model_remove: () => {
            throw { kind: "io", message: "A song is being separated right now." };
          },
        },
        onComputer("htdemucs"),
      );
      await toOptions(user);
      await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
      await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "A song is being separated right now.",
      );
      expect(screen.getByRole("radio", { name: "HTDemucs" })).toBeChecked();
      expect(screen.getByRole("button", { name: "Delete the HTDemucs model" })).toBeInTheDocument();
    });

    it("has no violations with the confirmation open", async () => {
      const { user } = setup({}, {}, onComputer("htdemucs"));
      await toOptions(user);
      await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
      await expectNoA11yViolations(dialog());
    });
  });

  it("leaves the 6-part engine off the list while its model is withdrawn", async () => {
    const { user, calls } = setup({}, {}, () => {
      backend.stemModels["htdemucs-6s"].available = false;
    });
    await toOptions(user);
    // The status of every model is asked for; the 6-part one says it is not available.
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "stem_model_status", args: { model: "htdemucs-6s" } }),
    );
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "HTDemucs" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("radio", { name: "HTDemucs 6-part" })).not.toBeInTheDocument();
    expect(screen.queryByText(/guitar and piano/i)).not.toBeInTheDocument();
  });

  describe("with the 6-part model available", () => {
    const available = () => {
      backend.stemModels["htdemucs-6s"] = stemModelStatus("htdemucs-6s", {
        available: true,
        downloadBytes: 123_000_000,
      });
    };

    it("lists it after HTDemucs, with an honest note about guitar and piano", async () => {
      const { user } = setup({}, {}, available);
      await toOptions(user);
      const card = await screen.findByRole("radio", { name: "HTDemucs 6-part" });
      const group = screen.getByRole("radiogroup", { name: "Engine" });
      expect(
        within(group)
          .getAllByRole("radio")
          .map((radio) => radio.getAttribute("value")),
      ).toEqual(["fast", "htdemucs", "htdemucs-6s", "scnet-xl", "scnet", "neural"]);
      expect(card).not.toBeChecked();
      const label = card.closest("[data-engine]")!;
      expect(label).toHaveTextContent("Six parts: drums, bass, vocals, guitar, piano");
      expect(label).toHaveTextContent("Guitar and piano are weaker");
      expect(label).toHaveTextContent("Download 117 MB");
      expect(label).not.toHaveTextContent("Recommended");
      expect(screen.getAllByText("Recommended")).toHaveLength(1);
    });

    it("says which parts it makes and which are weaker", async () => {
      const { user } = setup({}, {}, available);
      await toOptions(user);
      await user.click(await screen.findByRole("radio", { name: "HTDemucs 6-part" }));
      expect(screen.getByText(/HTDemucs 6-part separates/)).toHaveTextContent(
        "HTDemucs 6-part separates drums, bass, vocals, guitar, piano and other.",
      );
      expect(screen.getByText(/piano is the weakest/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download HTDemucs 6-part" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Separate" })).toBeDisabled();
    });

    it("downloads its model through the model commands", async () => {
      const { user, calls } = setup(
        {},
        {
          stem_model_download: async () => {
            backend.stemModels["htdemucs-6s"].downloaded = true;
            return null;
          },
        },
        available,
      );
      await toOptions(user);
      await user.click(await screen.findByRole("radio", { name: "HTDemucs 6-part" }));
      await user.click(screen.getByRole("button", { name: "Download HTDemucs 6-part" }));
      expect(screen.getByTestId("stem-neural-setup")).toHaveTextContent("Terms of HTDemucs 6-part");
      await user.click(screen.getByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "Accept and download" }));
      await waitFor(() =>
        expect(calls).toContainEqual({
          cmd: "stem_model_accept_terms",
          args: { model: "htdemucs-6s" },
        }),
      );
      expect(calls).toContainEqual({ cmd: "stem_model_download", args: { model: "htdemucs-6s" } });
    });

    it("separates with engine htdemucs-6s and asks for all five parts", async () => {
      const job = heldSeparation();
      const { user, calls } = setup({}, { stems_separate: job.handler }, () => {
        available();
        backend.stemModels["htdemucs-6s"].downloaded = true;
        backend.stemModels["htdemucs-6s"].termsAccepted = true;
      });
      await toOptions(user);
      await user.click(await screen.findByRole("radio", { name: "HTDemucs 6-part" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "Separate" }));
      expect(request(calls)).toEqual({
        path: SONG_PATH,
        kinds: ["drums", "bass", "vocals", "guitar", "piano"],
        engine: "htdemucs-6s",
        strongDrums: false,
      });
    });

    it("has no violations on the options step with the 6-part card", async () => {
      const { user } = setup({}, {}, available);
      await toOptions(user);
      await screen.findByRole("radio", { name: "HTDemucs 6-part" });
      await expectNoA11yViolations(dialog());
    });
  });

  it.each([
    ["UMX-HQ", "neural"],
    ["SCNet Small", "scnet"],
    ["SCNet XL", "scnet-xl"],
    ["HTDemucs", "htdemucs"],
  ] as const)("separates with %s once it is ready, sending engine %s", async (name, engine) => {
    const job = heldSeparation();
    const { user, calls } = setup({}, { stems_separate: job.handler }, () => {
      if (engine === "neural") {
        backend.umx = { ...UMX_STATUS, downloaded: true, termsAccepted: true };
      } else {
        backend.stemModels[engine].downloaded = true;
        backend.stemModels[engine].termsAccepted = true;
      }
    });
    await openEngine(user, name);
    await waitFor(() => expect(screen.getByRole("button", { name: "Separate" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Separate" }));
    expect(request(calls)).toEqual({
      path: SONG_PATH,
      kinds: ["drums", "bass", "vocals"],
      engine,
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

  it("has no violations on the options step with the engine cards", async () => {
    vi.mocked(isEnabled).mockImplementation((id) => id === "stem-separation-neural");
    const { user } = setup({}, {}, () => {
      backend.stemModels["scnet-xl"].available = false;
      backend.stemModels.scnet.downloaded = true;
      backend.stemModels.scnet.termsAccepted = true;
    });
    await openEngine(user, "HTDemucs");
    await screen.findByRole("button", { name: "Download HTDemucs" });
    await expectNoA11yViolations(dialog());
    await user.click(screen.getByRole("button", { name: "Download HTDemucs" }));
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
