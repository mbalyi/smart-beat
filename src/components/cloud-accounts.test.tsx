import { act, screen, waitFor, within } from "@testing-library/react";

import { CloudAccounts, CONNECT_GIVE_UP_MS } from "@/components/cloud-accounts";
import type { CloudAccount, PendingUpload } from "@/lib/cloud";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const ACCOUNTS: CloudAccount[] = [
  { provider: "drive", label: "Google Drive", configured: true, account: "me@example.com" },
  { provider: "onedrive", label: "OneDrive", configured: true, account: null },
  { provider: "dropbox", label: "Dropbox", configured: false, account: null },
];

describe("CloudAccounts", () => {
  it("is hidden outside the desktop app", () => {
    const { container } = renderWithProviders(<CloudAccounts />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows one row per provider with the right button", async () => {
    mockTauri({ cloud_accounts: () => ACCOUNTS });
    renderWithProviders(<CloudAccounts />);

    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Google Drive" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect OneDrive" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Not available in this build" })).toBeDisabled();
    await expectNoA11yViolations();
  });

  it("connects, shows the waiting state, then the account name", async () => {
    let accounts = ACCOUNTS;
    let finish: (name: string) => void = () => {};
    const calls = mockTauri({
      cloud_accounts: () => accounts,
      cloud_connect: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const { user } = renderWithProviders(<CloudAccounts />);

    await user.click(await screen.findByRole("button", { name: "Connect OneDrive" }));
    expect(await screen.findByRole("button", { name: "Waiting for the browser…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect Google Drive" })).toBeDisabled();

    accounts = [ACCOUNTS[0]!, { ...ACCOUNTS[1]!, account: "Test OneDrive account" }, ACCOUNTS[2]!];
    finish("Test OneDrive account");
    expect(await screen.findByText("Test OneDrive account")).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "cloud_connect")?.args).toEqual({ provider: "onedrive" });
    // Account names are never reported to usage statistics.
    expect(calls.some((c) => c.cmd === "track_event")).toBe(false);
  });

  it("shows the backend's error text when the sign-in fails after the browser step", async () => {
    mockTauri({
      cloud_accounts: () => ACCOUNTS,
      cloud_connect: () =>
        Promise.reject({ kind: "io", message: "The system keychain did not answer." }),
    });
    const { user } = renderWithProviders(<CloudAccounts />);

    await user.click(await screen.findByRole("button", { name: "Connect OneDrive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/keychain did not answer/);
    expect(screen.getByRole("button", { name: "Connect OneDrive" })).toBeEnabled();
  });

  it("Cancel stops the backend wait and returns the button to Connect without an error", async () => {
    const calls = mockTauri({
      cloud_accounts: () => ACCOUNTS,
      cloud_connect: () => new Promise<string>(() => {}),
      cloud_cancel_connect: () => null,
    });
    const { user } = renderWithProviders(<CloudAccounts />);

    await user.click(await screen.findByRole("button", { name: "Connect OneDrive" }));
    expect(await screen.findByRole("button", { name: "Waiting for the browser…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel connecting OneDrive" }));

    expect(await screen.findByRole("button", { name: "Connect OneDrive" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "cloud_cancel_connect")).toBe(true);
  });

  it("gives up waiting after a few minutes with a visible message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockTauri({
        cloud_accounts: () => ACCOUNTS,
        cloud_connect: () => new Promise<string>(() => {}),
        cloud_cancel_connect: () => null,
      });
      const { user } = renderWithProviders(<CloudAccounts />);

      await user.click(await screen.findByRole("button", { name: "Connect OneDrive" }));
      expect(
        await screen.findByRole("button", { name: "Waiting for the browser…" }),
      ).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONNECT_GIVE_UP_MS + 1000);
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(/took too long/);
      expect(screen.getByRole("button", { name: "Connect OneDrive" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects an account", async () => {
    let accounts = ACCOUNTS;
    const calls = mockTauri({
      cloud_accounts: () => accounts,
      cloud_disconnect: () => {
        accounts = [{ ...ACCOUNTS[0]!, account: null }, ACCOUNTS[1]!, ACCOUNTS[2]!];
        return null;
      },
    });
    const { user } = renderWithProviders(<CloudAccounts />);

    await user.click(await screen.findByRole("button", { name: "Disconnect Google Drive" }));
    expect(await screen.findByRole("button", { name: "Connect Google Drive" })).toBeInTheDocument();
    expect(calls.find((c) => c.cmd === "cloud_disconnect")?.args).toEqual({ provider: "drive" });
  });

  it("offers Reconnect after the sign-in expired", async () => {
    mockTauri({
      cloud_accounts: () => ACCOUNTS,
      cloud_connect: () => {
        throw { kind: "auth-expired", message: "token revoked" };
      },
    });
    const { user } = renderWithProviders(<CloudAccounts />);

    await user.click(await screen.findByRole("button", { name: "Connect OneDrive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/);
    expect(screen.getByRole("button", { name: "Reconnect OneDrive" })).toBeEnabled();
  });

  it("says so when connecting fails for another reason", async () => {
    mockTauri({
      cloud_accounts: () => ACCOUNTS,
      cloud_connect: () => {
        throw { kind: "network", message: "offline" };
      },
    });
    const { user } = renderWithProviders(<CloudAccounts />);

    await user.click(await screen.findByRole("button", { name: "Connect OneDrive" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be connected/);
    expect(alert).toHaveTextContent(/offline/);
    expect(screen.getByRole("button", { name: "Connect OneDrive" })).toBeEnabled();
  });

  it("shows the number of songs waiting to upload", async () => {
    const pending: PendingUpload[] = [1, 2].map((n) => ({
      provider: "drive",
      id: String(n),
      name: `song${n}.gp`,
      revision: "r",
      conflict: false,
    }));
    mockTauri({ cloud_accounts: () => ACCOUNTS, cloud_pending: () => pending });
    renderWithProviders(<CloudAccounts />);

    const note = await screen.findByTestId("cloud-pending");
    expect(within(note.parentElement as HTMLElement).getByText(/2 songs are waiting/)).toBe(note);
  });

  it("shows no pending note when nothing waits", async () => {
    mockTauri({ cloud_accounts: () => ACCOUNTS });
    renderWithProviders(<CloudAccounts />);
    await screen.findByText("me@example.com");
    await waitFor(() => expect(screen.queryByTestId("cloud-pending")).not.toBeInTheDocument());
  });

  it("reports when the accounts cannot be loaded", async () => {
    mockTauri({
      cloud_accounts: () => {
        throw { kind: "io", message: "disk on fire" };
      },
    });
    renderWithProviders(<CloudAccounts />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable.*disk on fire/);
  });
});
