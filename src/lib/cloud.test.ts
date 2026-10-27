import {
  connectCloudAccount,
  disconnectCloudAccount,
  flushCloudUploads,
  listCloudAccounts,
  listPendingUploads,
} from "@/lib/cloud";
import { NotInDesktopAppError } from "@/lib/tauri";
import { mockTauri } from "@/test/tauri";

describe("cloud commands", () => {
  it("lists accounts, pending uploads and flush results", async () => {
    const accounts = [
      { provider: "drive", label: "Google Drive", configured: true, account: "a@b.c" },
    ];
    const pending = [{ provider: "drive", id: "1", name: "a.gp", revision: "r", conflict: false }];
    const flushed = [{ name: "a.gp", outcome: "uploaded" }];
    mockTauri({
      cloud_accounts: () => accounts,
      cloud_pending: () => pending,
      cloud_flush: () => flushed,
    });
    expect(await listCloudAccounts()).toEqual(accounts);
    expect(await listPendingUploads()).toEqual(pending);
    expect(await flushCloudUploads()).toEqual(flushed);
  });

  it("sends the provider to connect and disconnect", async () => {
    const calls = mockTauri({ cloud_connect: () => "me@x.y", cloud_disconnect: () => null });
    expect(await connectCloudAccount("dropbox")).toBe("me@x.y");
    await disconnectCloudAccount("onedrive");
    expect(calls.filter((c) => c.cmd.startsWith("cloud_")).map((c) => [c.cmd, c.args])).toEqual([
      ["cloud_connect", { provider: "dropbox" }],
      ["cloud_disconnect", { provider: "onedrive" }],
    ]);
  });

  it("has defaults that mean no accounts and nothing pending", async () => {
    mockTauri();
    expect(await listCloudAccounts()).toEqual([]);
    expect(await listPendingUploads()).toEqual([]);
    expect(await flushCloudUploads()).toEqual([]);
  });

  describe("outside the desktop app", () => {
    it("lists nothing and refuses to connect", async () => {
      expect(await listCloudAccounts()).toEqual([]);
      expect(await listPendingUploads()).toEqual([]);
      await expect(connectCloudAccount("drive")).rejects.toBeInstanceOf(NotInDesktopAppError);
      await expect(flushCloudUploads()).rejects.toBeInstanceOf(NotInDesktopAppError);
    });
  });
});
