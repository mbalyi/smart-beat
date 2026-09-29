import { fetchLicenses, LICENSES_URL } from "@/lib/licenses";

describe("fetchLicenses", () => {
  it("returns the bundled notice file", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("MIT License …", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(fetchLicenses()).resolves.toBe("MIT License …");
    expect(fetch).toHaveBeenCalledWith(LICENSES_URL);
  });

  it("fails when the file is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    await expect(fetchLicenses()).rejects.toThrow("HTTP 404");
  });
});
