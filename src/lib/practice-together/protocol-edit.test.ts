import {
  CAPABILITIES,
  MAX_FRAME_CHARS,
  decode,
  encode,
  type EditBody,
} from "@/lib/practice-together/protocol";

const roundTrip = (body: unknown) => decode(encode({ type: "edit", body } as never, 1));

describe("protocol: editing together", () => {
  it("advertises the capability", () => {
    expect(CAPABILITIES).toContain("edit");
  });

  it("carries every kind of edit message", () => {
    const bodies: EditBody[] = [
      { k: "ops", ops: [{ t: "set", u: "a", d: { fret: 3 } }], from: "host", seq: 4 },
      { k: "ops", ops: [{ t: "del", u: "a" }], part: [1, 3] },
      { k: "rights", canEdit: false },
      { k: "since", seq: -1, key: "abc", resume: true },
      { k: "uids", pairs: [["a", "b"]], seq: 2 },
      { k: "live", seq: 2 },
      { k: "resync" },
      {
        k: "presence",
        cur: { track: "t0", beat: "b1", sel: ["b1", "b2"], string: 3 },
        who: "x",
        name: "Ann",
        hue: 12,
      },
      { k: "presence", cur: null },
    ];
    for (const body of bodies) expect(roundTrip(body)?.msg).toEqual({ type: "edit", body });
  });

  it("drops what is malformed instead of passing it on", () => {
    for (const body of [
      null,
      "ops",
      { k: "nope" },
      { k: "ops", ops: "x" },
      { k: "ops", ops: [{ nothing: 1 }] },
      { k: "ops", ops: [], part: [1] },
      { k: "ops", ops: [], part: [-1, 2] },
      { k: "rights", canEdit: "yes" },
      { k: "since", seq: "1" },
      { k: "uids", pairs: [["only one"]], seq: 1 },
      { k: "uids", pairs: Array.from({ length: 401 }, () => ["a", "b"]), seq: 1 },
      { k: "presence", cur: { track: 1, beat: "b" } },
      { k: "presence", cur: { track: "t", beat: "b", sel: ["a"] } },
    ]) {
      expect(roundTrip(body)).toBeNull();
    }
  });

  it("refuses a frame bigger than the limit", () => {
    const body = { k: "ops", ops: [{ t: "set", u: "a", d: { v: "x".repeat(MAX_FRAME_CHARS) } }] };
    expect(roundTrip(body)).toBeNull();
  });

  it("a tab offer says which edit it is from", () => {
    const offer = {
      type: "tab-offer",
      id: 1,
      name: "n",
      size: 1,
      chunks: 1,
      sha: "s",
      key: "k",
      bars: 1,
      seq: 7,
    } as const;
    expect(decode(encode(offer, 1))?.msg).toEqual(offer);
    expect(decode(encode({ ...offer, seq: "7" } as never, 1))).toBeNull();
  });
});
