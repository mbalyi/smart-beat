import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  liveAbortClaim,
  liveBeginClaim,
  liveCarry,
  liveClearWanted,
  liveDisown,
  liveEnd,
  liveIncludes,
  liveOwner,
  liveResume,
  liveSession,
  liveSetKey,
  liveSetOwner,
  liveSnapshot,
  liveStart,
  liveSuspend,
  liveTabClosed,
  liveTabWithKey,
  liveWant,
  resetLive,
  setLiveShower,
  subscribeLive,
  type LiveOwner,
  type LiveSession,
} from "@/lib/practice-together/live";

const session = (role: "host" | "guest" = "host") =>
  ({ role, leave: vi.fn() }) as unknown as LiveSession & { leave: Mock };

const owner = (id: number): Omit<LiveOwner, "ended"> & { ended: Mock } => ({
  id,
  pause: vi.fn(async () => {}),
  release: vi.fn(() => ({ hostCode: null, approvals: [] })),
  ended: vi.fn(),
});

beforeEach(() => resetLive());

describe("the live session", () => {
  it("starts in a tab, which owns it and is in it", () => {
    const s = session();
    liveStart(s, owner(1), "key-a");
    expect(liveSession()).toBe(s);
    expect(liveOwner()?.id).toBe(1);
    expect(liveIncludes(1)).toBe(true);
    expect(liveSnapshot()).toMatchObject({ live: true, role: "host", ownerId: 1, ids: [1] });
  });

  it("tells those who listen when it changes", () => {
    const seen = vi.fn();
    const stop = subscribeLive(seen);
    liveStart(session(), owner(1), "a");
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    liveSetKey(1, "b");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("moves to another tab, which joins it; the tab it left stays in it", () => {
    const s = session();
    liveStart(s, owner(1), "a");
    liveBeginClaim();
    expect(liveSnapshot().claiming).toBe(true);
    liveSetOwner(owner(2), "b", s);
    expect(liveSnapshot()).toMatchObject({ ownerId: 2, ids: [1, 2], claiming: false });
    expect(liveSession()).toBe(s);
  });

  it("stays where it was when a claim does not work out", () => {
    liveStart(session(), owner(1), "a");
    liveBeginClaim();
    liveAbortClaim();
    expect(liveSnapshot()).toMatchObject({ ownerId: 1, claiming: false });
  });

  it("finds the tab that has a song, the owner first", () => {
    liveStart(session(), owner(1), "a");
    liveSetOwner(owner(2), "b");
    liveSetKey(3, "a");
    expect(liveTabWithKey("b")).toBe(2);
    expect(liveTabWithKey("a")).toBe(1);
    expect(liveTabWithKey("zzz")).toBeNull();
    // A song edited in a tab changes the key it is found by.
    liveSetKey(1, "a2");
    expect(liveTabWithKey("a")).toBe(3);
  });

  it("tells two tabs of the same song apart by which of the host's tabs they are", () => {
    liveStart(session("guest"), owner(1), "song", 10);
    liveSetOwner(owner(2), "song", undefined, 20);
    // The one in play (2) is not the host's tab 10, so 10 finds tab 1 and 20 finds tab 2.
    expect(liveTabWithKey("song", 10)).toBe(1);
    expect(liveTabWithKey("song", 20)).toBe(2);
    // A tab of the host's that is not open here is not found, whatever the song.
    expect(liveTabWithKey("song", 30)).toBeNull();
    // Without an origin (an older host) the song is all there is: the shown tab first.
    expect(liveTabWithKey("song")).toBe(2);
  });

  it("matches a tab opened from a file by song alone, but prefers the exact tab", () => {
    liveStart(session("guest"), owner(1), "song");
    liveSetKey(3, "song", 20);
    expect(liveTabWithKey("song", 20)).toBe(3);
    expect(liveTabWithKey("song", 99)).toBe(1);
    // The tab closes: what it was is forgotten with it.
    liveTabClosed(3);
    expect(liveTabWithKey("song", 20)).toBe(1);
  });

  it("asks for a tab to be shown and moved to", () => {
    const shown = vi.fn();
    setLiveShower(shown);
    liveStart(session(), owner(1), "a");
    liveSetOwner(owner(2), "b");
    liveWant(1);
    expect(shown).toHaveBeenCalledWith(1);
    expect(liveSnapshot().wanted).toBe(1);
    liveClearWanted(1);
    expect(liveSnapshot().wanted).toBeNull();
  });

  it("names another tab of it when the owner closes, none for the last", () => {
    liveStart(session(), owner(1), "a");
    liveSetOwner(owner(2), "b");
    expect(liveTabClosed(2)).toBe(1);
    expect(liveIncludes(2)).toBe(false);
    expect(liveTabClosed(1)).toBeNull();
  });

  it("does not name a tab when one that does not own it closes", () => {
    liveStart(session(), owner(1), "a");
    liveSetOwner(owner(2), "b");
    expect(liveTabClosed(1)).toBeNull();
    expect(liveSnapshot().ids).toEqual([2]);
  });

  it("waits without an owner, keeping the host's code and queue for the next one", () => {
    liveStart(session(), owner(1), "a");
    const carry = { hostCode: { kind: "lan" as const, code: "ABCD" }, approvals: [] };
    liveDisown(carry);
    expect(liveOwner()).toBeNull();
    expect(liveCarry()).toBe(carry);
    expect(liveSnapshot().live).toBe(true);
  });

  it("a guest's session waits on its way to a tab that is opening, then resumes there", () => {
    liveStart(session("guest"), owner(1), "a");
    liveSuspend();
    expect(liveSession()).toBeNull();
    expect(liveSnapshot().live).toBe(false);
    const next = session("guest");
    liveResume(next, owner(2), "b");
    expect(liveSession()).toBe(next);
    // The tabs of the session stay in it.
    expect(liveSnapshot()).toMatchObject({ live: true, ownerId: 2, ids: [1, 2] });
  });

  it("ends: the session leaves, the owner is told, nothing is left", () => {
    const s = session();
    const o = owner(1);
    liveStart(s, o, "a");
    liveEnd();
    expect(s.leave).toHaveBeenCalledTimes(1);
    expect(o.ended).toHaveBeenCalledTimes(1);
    expect(liveSnapshot().live).toBe(false);
    expect(liveSession()).toBeNull();
  });
});
