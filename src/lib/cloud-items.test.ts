import {
  cloudErrorText,
  cloudItemName,
  createCloudItem,
  isCloudAvailabilityError,
  isCloudItem,
  listCloudItems,
  providerOf,
  readCloudItem,
  rememberCloudName,
  saveCloudItem,
} from "@/lib/cloud-items";
import { mockTauri } from "@/test/tauri";

/** Records the headers of every raw-body invoke, as the real IPC would send them. */
function recordHeaders() {
  const seen: Array<{ cmd: string; headers?: Record<string, string> }> = [];
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: unknown } })
    .__TAURI_INTERNALS__;
  const original = internals.invoke as (...a: unknown[]) => Promise<unknown>;
  internals.invoke = (
    cmd: string,
    args: unknown,
    options?: { headers?: Record<string, string> },
  ) => {
    seen.push({ cmd, headers: options?.headers });
    return original(cmd, args, options);
  };
  return seen;
}

describe("isCloudItem", () => {
  it("recognises provider prefixes only", () => {
    expect(isCloudItem("drive:abc")).toBe(true);
    expect(isCloudItem("onedrive:abc")).toBe(true);
    expect(isCloudItem("dropbox:abc")).toBe(true);
    expect(isCloudItem("C:\\a.gp")).toBe(false);
    expect(isCloudItem("/songs/a.gp")).toBe(false);
    expect(isCloudItem("drive:")).toBe(false);
    expect(providerOf("drive:abc")).toBe("drive");
    expect(providerOf("/x")).toBeNull();
  });
});

describe("cloud item commands", () => {
  it("lists the tabs of a provider", async () => {
    const item = { id: "drive:1", name: "a.gp", revision: "r", size: 3, modified_ms: 1 };
    const calls = mockTauri({ cloud_list: () => [item] });
    expect(await listCloudItems("drive")).toEqual([item]);
    expect(calls.find((c) => c.cmd === "cloud_list")!.args).toEqual({ provider: "drive" });
  });

  it("reads the raw bytes", async () => {
    mockTauri({ cloud_read: () => new Uint8Array([1, 2, 3]).buffer });
    expect(await readCloudItem("drive:1")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("saves with the item in a header and returns saved or queued", async () => {
    mockTauri({ cloud_save: () => "queued" });
    const seen = recordHeaders();
    expect(await saveCloudItem("dropbox:x", new Uint8Array([1]))).toBe("queued");
    expect(seen.find((s) => s.cmd === "cloud_save")!.headers).toEqual({ item: "dropbox:x" });
  });

  it("creates with provider and URL-encoded name headers", async () => {
    mockTauri({ cloud_create: () => "drive:new" });
    const seen = recordHeaders();
    expect(await createCloudItem("drive", "my song é.gp", new Uint8Array([1]))).toBe("drive:new");
    expect(seen.find((s) => s.cmd === "cloud_create")!.headers).toEqual({
      provider: "drive",
      name: encodeURIComponent("my song é.gp"),
    });
  });
});

describe("cloud errors and names", () => {
  it("tells reconnect from offline, and ignores other errors", () => {
    expect(cloudErrorText({ kind: "auth-expired", message: "x" }, "drive")).toBe(
      "Reconnect Google Drive in Settings",
    );
    expect(cloudErrorText({ kind: "network", message: "x" }, "dropbox")).toMatch(/Dropbox/);
    expect(cloudErrorText({ kind: "io", message: "x" }, "drive")).toBeNull();
    expect(isCloudAvailabilityError({ kind: "network", message: "x" })).toBe(true);
    expect(isCloudAvailabilityError({ kind: "not-found", message: "x" })).toBe(false);
  });

  it("remembers a name for the recent list", () => {
    rememberCloudName("drive:9", "riff.gp");
    expect(cloudItemName("drive:9")).toBe("riff.gp");
    expect(cloudItemName("drive:none")).toBeNull();
  });
});
