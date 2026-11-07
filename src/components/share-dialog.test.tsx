import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";

import { ShareButton } from "@/components/share-button";
import { Toaster } from "@/components/ui/sonner";
import type { ShareTarget } from "@/lib/cloud-share";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";
import { ShareProvider } from "@/providers/share-provider";

const BOTH = ["view", "edit"];

/** The accounts the next `setup` gives the mocked core (`mockTauri` clears them). */
let accounts: typeof backend.cloudAccounts = [];

beforeEach(() => {
  accounts = [];
});

function connect(...providers: ("drive" | "onedrive" | "dropbox")[]) {
  const all: Record<
    "drive" | "onedrive" | "dropbox",
    { provider: string; label: string; shareLevels: string[] }
  > = {
    drive: { provider: "drive", label: "Google Drive", shareLevels: BOTH },
    onedrive: { provider: "onedrive", label: "OneDrive", shareLevels: BOTH },
    dropbox: { provider: "dropbox", label: "Dropbox", shareLevels: BOTH },
  };
  accounts = (["drive", "onedrive", "dropbox"] as const).map((p) => ({
    ...all[p],
    account: providers.includes(p) ? `me@${p}.test` : null,
  }));
}

/** A share icon for `target`, with the dialog and the notifications around it. */
function setup(target: ShareTarget, overrides: Parameters<typeof mockTauri>[0] = {}) {
  const calls = mockTauri(overrides);
  backend.cloudAccounts = accounts;
  const onSetUpCloud = vi.fn();
  const ui = renderWithProviders(
    <ShareProvider onSetUpCloud={onSetUpCloud}>
      <ShareButton target={target} />
      <Toaster />
    </ShareProvider>,
  );
  return { ...ui, calls, onSetUpCloud };
}

const open = async (user: ReturnType<typeof setup>["user"]) => {
  await user.click(screen.getByRole("button", { name: /^Share a link to/ }));
  return screen.findByRole("dialog");
};

const cloudTab: ShareTarget = { kind: "cloud", item: "drive:f1", name: "riff.gp" };
const localTab: ShareTarget = { kind: "tab", path: "/songs/riff.gp5", name: "riff.gp5" };
const localStems: ShareTarget = { kind: "stems", songId: "aaaaaaaaaaaaaaaa", name: "Neon Nights" };

describe("ShareDialog: a file that is in a drive", () => {
  it("copies a view link and says so", async () => {
    connect("drive");
    const { user, calls } = setup(cloudTab);
    const dialog = await open(user);

    // It starts at what the link allows: the storage is known.
    expect(within(dialog).queryByTestId("share-levels")).toBeInTheDocument();
    expect(within(dialog).queryByRole("list", { name: "Steps" })).not.toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "Copy link" }));

    const link = await within(dialog).findByRole("textbox", { name: "Share link" });
    expect(link).toHaveValue("https://share.example.com/drive%3Af1?as=view");
    expect(await navigator.clipboard.readText()).toBe(
      "https://share.example.com/drive%3Af1?as=view",
    );
    expect(
      await screen.findByText("Link copied", { selector: "[data-title]" }),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "cloud_share")).toEqual([
      expect.objectContaining({ args: { item: "drive:f1", level: "view" } }),
    ]);
    // Nothing is uploaded for a file that is in the drive already.
    expect(calls.some((c) => c.cmd === "cloud_create")).toBe(false);
  });

  it("makes an edit link when asked", async () => {
    connect("drive");
    const { user, calls } = setup(cloudTab);
    const dialog = await open(user);

    await user.click(await within(dialog).findByRole("radio", { name: "Can edit" }));
    await user.click(within(dialog).getByRole("button", { name: "Copy link" }));

    await within(dialog).findByRole("textbox", { name: "Share link" });
    expect(calls.find((c) => c.cmd === "cloud_share")?.args).toEqual({
      item: "drive:f1",
      level: "edit",
    });
    expect(within(dialog).getByText(/can change the file/)).toBeInTheDocument();
  });

  it("offers edit links for Dropbox too", async () => {
    connect("dropbox");
    const { user, calls } = setup({ kind: "cloud", item: "dropbox:/a.gp", name: "a.gp" });
    const dialog = await open(user);

    const edit = await within(dialog).findByRole("radio", { name: "Can edit" });
    expect(edit).toBeEnabled();
    await user.click(edit);
    await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
    await within(dialog).findByRole("textbox", { name: "Share link" });
    expect(calls.find((c) => c.cmd === "cloud_share")?.args).toEqual({
      item: "dropbox:/a.gp",
      level: "edit",
    });
  });

  it("offers only view where a service makes no edit links", async () => {
    accounts = [
      { provider: "dropbox", label: "Dropbox", account: "me@db.test", shareLevels: ["view"] },
    ];
    const { user } = setup({ kind: "cloud", item: "dropbox:/a.gp", name: "a.gp" });
    const dialog = await open(user);

    const edit = await within(dialog).findByRole("radio", { name: "Can edit" });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAccessibleDescription(/can only be viewed/);
    expect(within(dialog).getByRole("radio", { name: "Can view" })).toBeChecked();
  });

  it("shows the link to copy by hand when the clipboard refuses", async () => {
    connect("drive");
    const { user } = setup(cloudTab);
    const dialog = await open(user);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    const notify = vi.spyOn(toast, "success");

    await user.click(await within(dialog).findByRole("button", { name: "Copy link" }));

    expect(await within(dialog).findByText(/clipboard did not accept it/)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Share link" })).toHaveValue(
      "https://share.example.com/drive%3Af1?as=view",
    );
    expect(notify).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("heading", { name: "Your link is ready" })).toBeVisible();
  });

  it("explains a failure and tries again", async () => {
    connect("drive");
    let fail = true;
    const { user } = setup(cloudTab, {
      cloud_share: () => {
        if (fail) throw { kind: "io", message: "This account does not allow sharing." };
        return "https://share.example.com/ok";
      },
    });
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole("button", { name: "Copy link" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This account does not allow sharing.",
    );
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("textbox", { name: "Share link" })).toHaveValue(
      "https://share.example.com/ok",
    );
  });

  it("sends a signed-out account to the cloud settings", async () => {
    connect("drive");
    const { user, onSetUpCloud } = setup(cloudTab, {
      cloud_share: () => {
        throw { kind: "auth-expired", message: "The cloud sign-in expired." };
      },
    });
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole("button", { name: "Copy link" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Reconnect Google Drive in Settings",
    );
    await user.click(within(dialog).getByRole("button", { name: "Open cloud settings" }));
    expect(onSetUpCloud).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes with Cancel and with Done", async () => {
    connect("drive");
    const { user } = setup(cloudTab);
    let dialog = await open(user);
    await user.click(await within(dialog).findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await open(user);
    await user.click(await within(dialog).findByRole("button", { name: "Copy link" }));
    await user.click(await within(dialog).findByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("ShareDialog: a file on this computer", () => {
  it("puts the title above the steps, as a dialog header", async () => {
    connect("drive");
    const { user } = setup(localTab);
    const dialog = await open(user);

    const title = await within(dialog).findByRole("heading", { name: "Where should it go?" });
    const steps = within(dialog).getByRole("list", { name: "Steps" });
    expect(title.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.closest("[data-slot=dialog-header]")).toContainElement(steps);
  });

  it("asks which storage first, uploads a copy and then copies the link", async () => {
    connect("drive", "onedrive");
    const { user, calls } = setup(localTab, {
      read_score_file: () => new Uint8Array([1, 2, 3]).buffer,
      cloud_create: () => "onedrive:new1",
    });
    const dialog = await open(user);

    expect(
      await within(dialog).findByRole("heading", { name: "Where should it go?" }),
    ).toBeVisible();
    // A drive that is not connected is greyed out, not hidden.
    expect(within(dialog).getByRole("button", { name: /Upload to Dropbox/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Upload to OneDrive" }));
    expect(within(dialog).getByRole("heading", { name: "Who can use the link?" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Upload and copy link" }));

    expect(await within(dialog).findByRole("textbox", { name: "Share link" })).toHaveValue(
      "https://share.example.com/onedrive%3Anew1?as=view",
    );
    const create = calls.find((c) => c.cmd === "cloud_create");
    expect(create?.headers).toEqual({ provider: "onedrive", name: "riff.gp5" });
    expect(await navigator.clipboard.readText()).toContain("onedrive%3Anew1");
  });

  it("goes back to the storage choice", async () => {
    connect("drive", "onedrive");
    const { user } = setup(localTab);
    const dialog = await open(user);

    await user.click(await within(dialog).findByRole("button", { name: "Upload to Google Drive" }));
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByRole("heading", { name: "Where should it go?" })).toBeVisible();
  });

  it("does not upload a second copy when the link has to be tried again", async () => {
    connect("drive");
    let fail = true;
    const { user, calls } = setup(localTab, {
      read_score_file: () => new Uint8Array([1]).buffer,
      cloud_create: () => "drive:new1",
      cloud_share: () => {
        if (fail) throw { kind: "network", message: "Offline." };
        return "https://share.example.com/ok";
      },
    });
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole("button", { name: "Upload to Google Drive" }));
    await user.click(within(dialog).getByRole("button", { name: "Upload and copy link" }));
    await within(dialog).findByRole("alert");

    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByRole("textbox", { name: "Share link" });
    expect(calls.filter((c) => c.cmd === "cloud_create")).toHaveLength(1);
  });

  it("says so when no drive is connected, and points to the settings", async () => {
    connect();
    const { user, onSetUpCloud } = setup(localTab);
    const dialog = await open(user);

    expect(await within(dialog).findByTestId("share-no-storage")).toHaveTextContent(
      /No online drive is connected/,
    );
    for (const name of ["Google Drive", "OneDrive", "Dropbox"]) {
      expect(
        within(dialog).getByRole("button", { name: new RegExp(`Upload to ${name}`) }),
      ).toBeDisabled();
    }
    await user.click(within(dialog).getByRole("button", { name: "Set up cloud storage" }));
    expect(onSetUpCloud).toHaveBeenCalledOnce();
  });

  it("shows a build without credentials as not available", async () => {
    accounts = [{ provider: "drive", label: "Google Drive", configured: false, account: null }];
    const { user } = setup(localTab);
    const dialog = await open(user);

    expect(
      await within(dialog).findByRole("button", {
        name: "Upload to Google Drive, Not available in this build",
      }),
    ).toBeDisabled();
  });
});

describe("ShareDialog: stems", () => {
  it("saves the stems to the storage as their own file and links to it", async () => {
    connect("drive");
    const { user, calls } = setup(localStems);
    const dialog = await open(user);

    await user.click(await within(dialog).findByRole("button", { name: "Upload to Google Drive" }));
    expect(within(dialog).getByText(/shared as their own stems file/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Upload and copy link" }));

    await within(dialog).findByRole("textbox", { name: "Share link" });
    const save = calls.find((c) => c.cmd === "stems_cloud_save");
    expect(save?.args).toEqual({
      request: { id: "aaaaaaaaaaaaaaaa", provider: "drive", includeOriginal: false },
    });
    // The link is for the file the save made.
    expect(calls.find((c) => c.cmd === "cloud_share")?.args).toEqual({
      item: "drive:1",
      level: "view",
    });
  });

  it("stops quietly when the person cancels the upload", async () => {
    connect("drive");
    const stop = { resolve: (_: unknown) => {} };
    const { user, calls } = setup(localStems, {
      stems_cloud_save: () => new Promise((_, reject) => (stop.resolve = reject)),
      stems_cancel: () => {
        stop.resolve({ kind: "audio", message: "Stem file stopped." });
        return null;
      },
    });
    const dialog = await open(user);
    await user.click(await within(dialog).findByRole("button", { name: "Upload to Google Drive" }));
    await user.click(within(dialog).getByRole("button", { name: "Upload and copy link" }));
    await user.click(await within(dialog).findByRole("button", { name: "Cancel" }));

    // Back at the choice, with no error and no link.
    expect(await within(dialog).findByTestId("share-levels")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "cloud_share")).toBe(false);
  });
});

describe("ShareDialog: accessibility", () => {
  it("has no violations on any step", async () => {
    connect("drive");
    const { user } = setup(localTab, {
      read_score_file: () => new Uint8Array([1]).buffer,
      cloud_create: () => "drive:new1",
    });
    const dialog = await open(user);
    await within(dialog).findByRole("button", { name: "Upload to Google Drive" });
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Upload to Google Drive" }));
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Upload and copy link" }));
    await within(dialog).findByRole("textbox", { name: "Share link" });
    await expectNoA11yViolations(dialog);
  });
});
