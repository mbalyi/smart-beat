import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor, within } from "@testing-library/react";

import { StemModelsDialog } from "@/components/stems/stem-models-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";

type ModelName = "scnet" | "scnet-xl" | "htdemucs" | "htdemucs-6s";

/** `seed` changes the mocked backend, which `mockTauri` resets, before the dialog renders. */
async function setup(overrides: Parameters<typeof mockTauri>[0] = {}, seed?: () => void) {
  const calls = mockTauri(overrides);
  seed?.();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(<StemModelsDialog open onOpenChange={onOpenChange} />);
  await screen.findByRole("dialog", { name: "Stem Separation Models" });
  return { ...utils, calls, onOpenChange };
}
const onComputer =
  (...models: ModelName[]) =>
  () => {
    for (const model of models) {
      backend.stemModels[model].downloaded = true;
      backend.stemModels[model].termsAccepted = true;
    }
  };
const row = (id: string) => screen.getByTestId(`model-row-${id}`);
const closeButton = () =>
  screen.getAllByRole("button", { name: "Close" }).find((b) => b.dataset.slot !== "dialog-close")!;

beforeEach(() => document.documentElement.classList.remove("dark"));

describe("StemModelsDialog", () => {
  it("lists every engine of Stem separation, with what it is best at, its cost and its size", async () => {
    await setup();
    expect(screen.getByRole("heading", { name: "Engines", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("Used by Stem separation")).toBeInTheDocument();
    await waitFor(() => expect(row("htdemucs")).toHaveTextContent("Download 168 MB"));
    const ids = within(screen.getByRole("region")).getAllByRole("listitem");
    expect(ids.map((item) => item.getAttribute("data-testid"))).toEqual([
      "model-row-fast",
      "model-row-htdemucs",
      "model-row-htdemucs-6s",
      "model-row-scnet-xl",
      "model-row-scnet",
      "model-row-neural",
    ]);
    expect(row("htdemucs")).toHaveTextContent("Recommended");
    expect(row("htdemucs")).toHaveTextContent("Best all-round choice");
    expect(row("htdemucs")).toHaveTextContent("1.6 GB of memory");
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(row("scnet-xl")).toHaveTextContent("Best for vocals");
    expect(row("scnet-xl")).toHaveTextContent("Download 206 MB");
    expect(row("neural")).toHaveTextContent("Download 136 MB");
    // The 6-part engine is on the list now that its model is hosted, with its size and its caveat.
    expect(row("htdemucs-6s")).toHaveTextContent("HTDemucs 6-part");
    expect(row("htdemucs-6s")).toHaveTextContent("Download 111 MB");
    expect(row("htdemucs-6s")).toHaveTextContent("Guitar is the weaker of the main parts");
    expect(row("fast")).toHaveTextContent("Built in");
    expect(row("fast")).toHaveTextContent("Nothing to install");
    expect(within(row("fast")).queryByRole("button")).toBeNull();
  });

  it("offers Install for a model that is not there and Delete for one that is", async () => {
    await setup({}, onComputer("scnet"));
    await waitFor(() => expect(row("scnet")).toHaveTextContent("Installed"));
    expect(row("scnet")).toHaveTextContent("Installed");
    expect(
      within(row("scnet")).getByRole("button", { name: "Delete the SCNet Small model" }),
    ).toBeEnabled();
    expect(within(row("scnet")).queryByRole("button", { name: /Install/ })).toBeNull();
    expect(row("htdemucs")).toHaveTextContent("Not installed");
    expect(
      within(row("htdemucs")).getByRole("button", { name: "Install the HTDemucs model" }),
    ).toBeEnabled();
  });

  it("leaves a model that is not published without buttons", async () => {
    await setup({}, () => {
      backend.stemModels["scnet-xl"].available = false;
    });
    await waitFor(() => expect(row("scnet-xl")).toHaveTextContent("Not published yet"));
    expect(within(row("scnet-xl")).queryByRole("button")).toBeNull();
  });

  it("takes the 6-part model out of the list while it is withdrawn", async () => {
    await setup({}, () => {
      backend.stemModels["htdemucs-6s"].available = false;
    });
    await waitFor(() => expect(row("htdemucs")).toHaveTextContent("Download"));
    expect(screen.queryByTestId("model-row-htdemucs-6s")).toBeNull();
  });

  it("installs the 6-part model: terms first, then the download with its progress", async () => {
    let release!: () => void;
    const { user, calls } = await setup({
      stem_model_download: async () => {
        await emit("stem-model-download-progress", {
          model: "htdemucs-6s",
          downloadedBytes: 40,
          totalBytes: 100,
        });
        await new Promise<void>((resolve) => (release = resolve));
        backend.stemModels["htdemucs-6s"].downloaded = true;
        return null;
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Install the HTDemucs 6-part model" }),
    );
    const terms = screen.getByTestId("stem-neural-setup");
    expect(terms).toHaveTextContent("Terms of HTDemucs 6-part");
    const accept = within(terms).getByRole("button", { name: "Accept and download" });
    expect(accept).toBeDisabled();
    await user.click(within(terms).getByRole("checkbox", { name: /I only use music/ }));
    await user.click(accept);
    expect(calls).toContainEqual({
      cmd: "stem_model_accept_terms",
      args: { model: "htdemucs-6s" },
    });
    expect(calls).toContainEqual({ cmd: "stem_model_download", args: { model: "htdemucs-6s" } });
    const bar = await screen.findByRole("progressbar", { name: "Download progress" });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "40"));

    // The window stays while it downloads.
    expect(closeButton()).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(row("htdemucs-6s")).toHaveTextContent("Installed"));
    expect(
      within(row("htdemucs-6s")).getByRole("button", { name: "Delete the HTDemucs 6-part model" }),
    ).toBeEnabled();
    expect(closeButton()).toBeEnabled();
  });

  it("cannot be left while a download runs, and cancelling lets it go", async () => {
    const { user, calls, onOpenChange } = await setup({
      stem_model_download: () => new Promise(() => {}),
    });
    await user.click(await screen.findByRole("button", { name: "Install the SCNet Small model" }));
    await user.click(screen.getByRole("checkbox", { name: /I only use music/ }));
    await user.click(screen.getByRole("button", { name: "Accept and download" }));
    await screen.findByRole("progressbar");
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(calls.map((call) => call.cmd)).toContain("stem_model_cancel");
  });

  it("says why an install failed and keeps the terms open to try again", async () => {
    const { user } = await setup({
      stem_model_download: () => {
        throw { kind: "network", message: "No connection." };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Install the SCNet Small model" }));
    await user.click(screen.getByRole("checkbox", { name: /I only use music/ }));
    await user.click(screen.getByRole("button", { name: "Accept and download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No connection.");
    expect(screen.getByRole("button", { name: "Accept and download" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(row("scnet")).toBeInTheDocument();
  });

  it("deletes with a second click, Keep backs out, and the row goes back to Install", async () => {
    const { user, calls } = await setup({}, onComputer("htdemucs"));
    await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(calls.some((call) => call.cmd === "stem_model_remove")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete the HTDemucs model" }));
    await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
    expect(calls).toContainEqual({ cmd: "stem_model_remove", args: { model: "htdemucs" } });
    await waitFor(() => expect(row("htdemucs")).toHaveTextContent("Not installed"));
    expect(
      within(row("htdemucs")).getByRole("button", { name: "Install the HTDemucs model" }),
    ).toBeEnabled();
  });

  it("deletes UMX-HQ through its own command", async () => {
    const { user, calls } = await setup({}, () => {
      backend.umx.downloaded = true;
      backend.umx.termsAccepted = true;
    });
    await user.click(await screen.findByRole("button", { name: "Delete the UMX-HQ model" }));
    await user.click(screen.getByRole("button", { name: "Delete UMX-HQ" }));
    expect(calls.map((call) => call.cmd)).toContain("umx_model_remove");
    await waitFor(() => expect(row("neural")).toHaveTextContent("Not installed"));
  });

  it("keeps every Delete off while one delete is under way, and says why one failed", async () => {
    let fail!: () => void;
    const { user } = await setup(
      {
        stem_model_remove: () =>
          new Promise((_resolve, reject) => {
            fail = () => reject({ kind: "io", message: "A song is being separated right now." });
          }),
      },
      onComputer("htdemucs", "scnet"),
    );
    await user.click(await screen.findByRole("button", { name: "Delete the HTDemucs model" }));
    await user.click(screen.getByRole("button", { name: "Delete HTDemucs" }));
    const other = screen.getByRole("button", { name: "Delete the SCNet Small model" });
    await waitFor(() => expect(other).toBeDisabled());
    await act(async () => fail());
    expect(await screen.findByRole("alert")).toHaveTextContent("A song is being separated");
    await waitFor(() => expect(other).toBeEnabled());
    expect(row("htdemucs")).toHaveTextContent("Installed");
  });

  it("closes with Close", async () => {
    const { user, onOpenChange } = await setup();
    await user.click(closeButton());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("has no accessibility violations in light and dark, in the list and at the terms", async () => {
    const { user } = await setup({}, onComputer("scnet"));
    await screen.findByRole("button", { name: "Delete the SCNet Small model" });
    const dialog = screen.getByRole("dialog");
    await expectNoA11yViolations(dialog);
    await user.click(screen.getByRole("button", { name: "Delete the SCNet Small model" }));
    await expectNoA11yViolations(dialog);
    document.documentElement.classList.add("dark");
    await expectNoA11yViolations(dialog);
    await user.click(screen.getByRole("button", { name: "Keep" }));
    await user.click(screen.getByRole("button", { name: "Install the HTDemucs model" }));
    await expectNoA11yViolations(dialog);
  });
});
