import {
  LAST_SESSION_TTL_MS,
  forgetSession,
  guestId,
  readLastSession,
  rememberSession,
} from "@/lib/practice-together/identity";

const KEY = "smart-beat:practice-together:last";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the remembered session", () => {
  it("is remembered and read back", () => {
    rememberSession({ kind: "internet", code: "ABCD-EFGH", host: "Drummer", at: 1_000 });
    expect(readLastSession(2_000)).toEqual({
      kind: "internet",
      code: "ABCD-EFGH",
      host: "Drummer",
      at: 1_000,
    });
  });

  it("expires, and is not from the future", () => {
    rememberSession({ kind: "lan", code: "X", at: 1_000 });
    expect(readLastSession(1_000 + LAST_SESSION_TTL_MS)).not.toBeNull();
    expect(readLastSession(1_001 + LAST_SESSION_TTL_MS)).toBeNull();
    expect(readLastSession(500)).toBeNull();
  });

  it("is forgotten on request", () => {
    rememberSession({ kind: "lan", code: "X", at: Date.now() });
    forgetSession();
    expect(readLastSession()).toBeNull();
  });

  it.each([
    ["not json", "{"],
    ["not an object", "5"],
    ["another kind", JSON.stringify({ kind: "bluetooth", code: "X", at: 1 })],
    ["no code", JSON.stringify({ kind: "lan", at: 1 })],
    ["no time", JSON.stringify({ kind: "lan", code: "X" })],
  ])("ignores a stored value that is %s", (_name, value) => {
    localStorage.setItem(KEY, value);
    expect(readLastSession(2)).toBeNull();
  });

  it("drops a host name that is not text", () => {
    localStorage.setItem(KEY, JSON.stringify({ kind: "lan", code: "X", at: 1, host: 5 }));
    expect(readLastSession(2)).toEqual({ kind: "lan", code: "X", at: 1 });
  });

  it("works without storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberSession({ kind: "lan", code: "X", at: 1 })).not.toThrow();
    expect(readLastSession()).toBeNull();
    expect(() => forgetSession()).not.toThrow();
    expect(guestId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
