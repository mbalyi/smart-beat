import { act, renderHook } from "@testing-library/react";

import { useTabSharing, type ReceivedScore } from "@/hooks/use-tab-sharing";
import { useScoreDocuments } from "@/hooks/use-score-document";
import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import { loadSong } from "@/lib/import";
import { mixFromScore } from "@/lib/score/mixer";
import { fixtureBytes } from "@/test/score";

async function practiceSong() {
  const { score } = await loadSong(fixtureBytes("practice-song.gp"), "practice-song.gp");
  return score;
}

function setup(score: Awaited<ReturnType<typeof practiceSong>>) {
  const scoreRef = { current: score };
  const titleRef = { current: "Practice song" };
  const revisionRef = { current: 0 };
  const detach = vi.fn();
  const detachRef = { current: detach };
  const receive = vi.fn<(tab: ReceivedScore) => void>();
  const receiveRef = { current: receive as ((tab: ReceivedScore) => void) | undefined };
  const hook = renderHook(() =>
    useTabSharing({ scoreRef, titleRef, revisionRef, detachRef, receiveRef }),
  );
  return { hook, detach, receive, receiveRef, revisionRef };
}

describe("useTabSharing", () => {
  it("offers the open score as a Guitar Pro file with the fingerprint of the same version", async () => {
    const score = await practiceSong();
    const { hook } = setup(score);

    const offer = await hook.result.current.hooks.offer!();

    expect(offer).not.toBeNull();
    expect(offer!.name).toBe("Practice song");
    expect(offer!.key).toBe((await scoreFingerprint(score)).key);
    expect(offer!.bars).toBe(score.masterBars.length);
    expect(offer!.bytes.length).toBeGreaterThan(100);
  });

  it("reads a received tab, and moves the session only when the answer went out", async () => {
    const host = await practiceSong();
    const guest = setup(await practiceSong());
    const offer = await setup(host).hook.result.current.hooks.offer!();

    const reason = await guest.hook.result.current.hooks.receive!({ ...offer!, from: "Mark" });
    expect(reason).toBeNull();
    // Reading is not opening: the session stays here until `opened`.
    expect(guest.receive).not.toHaveBeenCalled();
    expect(guest.detach).not.toHaveBeenCalled();

    act(() => guest.hook.result.current.hooks.opened!());
    expect(guest.detach).toHaveBeenCalledWith(offer!.key);
    expect(guest.receive).toHaveBeenCalledOnce();
    const tab = guest.receive.mock.calls[0]![0];
    expect(tab).toMatchObject({ name: "Practice song", key: offer!.key, from: "Mark" });
    expect(tab.score.tracks).toHaveLength(host.tracks.length);
    // The connection is handed over before the tab opens.
    expect(guest.detach.mock.invocationCallOrder[0]!).toBeLessThan(
      guest.receive.mock.invocationCallOrder[0]!,
    );
  });

  it("reports a damaged file as unreadable and a missing opener as unsupported", async () => {
    const guest = setup(await practiceSong());
    const tab = { name: "x", bytes: new Uint8Array([1, 2, 3, 4]), key: "k", bars: 1, from: "A" };
    expect(await guest.hook.result.current.hooks.receive!(tab)).toBe("unreadable");
    expect(guest.receive).not.toHaveBeenCalled();

    guest.receiveRef.current = undefined;
    expect(await guest.hook.result.current.hooks.receive!(tab)).toBe("unsupported");
  });

  it("keeps the host's fingerprint until the tab is edited", async () => {
    const score = await practiceSong();
    const { hook, revisionRef } = setup(score);
    hook.result.current.trust("hosts-key", 0);

    expect((await hook.result.current.fingerprint(score, 0)).key).toBe("hosts-key");
    revisionRef.current = 1;
    const edited = await hook.result.current.fingerprint(score, 1);
    expect(edited.key).toBe((await scoreFingerprint(score)).key);
    expect(edited.key).not.toBe("hosts-key");
  });
});

describe("opening a received tab", () => {
  let practiceScore: Awaited<ReturnType<typeof practiceSong>>;
  beforeEach(async () => {
    practiceScore = await practiceSong();
  });

  it("opens it as its own tab, marked with who sent it", async () => {
    const { result } = renderHook(() => useScoreDocuments());

    await act(() =>
      result.current.openReceived({ score: practiceScore, name: "Riff", key: "k1", from: "Mark" }),
    );

    const song = result.current.song!;
    expect(song.name).toBe("Riff (from Mark)");
    expect(song.received).toEqual({ from: "Mark", key: "k1" });
    expect(song.path).toBeNull();
    // Closing it does not ask to save: the host has the tab.
    expect(song.unsaved).toBeFalsy();
    expect(result.current.songs).toHaveLength(1);
  });

  it("replaces an earlier version in its place and keeps the guest's mix", async () => {
    const { result } = renderHook(() => useScoreDocuments());
    await act(() =>
      result.current.openReceived({ score: practiceScore, name: "Riff", key: "k1", from: "Mark" }),
    );
    await act(() =>
      result.current.openReceived({ score: practiceScore, name: "Other", key: "k9", from: "Mark" }),
    );
    const first = result.current.songs[0]!;
    const guestMix = mixFromScore(first.summary);
    guestMix.tracks[0] = { ...guestMix.tracks[0]!, mute: true };

    await act(() =>
      result.current.openReceived(
        { score: practiceScore, name: "Riff", key: "k2", from: "Mark" },
        { replaceId: first.id, mix: guestMix },
      ),
    );

    expect(result.current.songs.map((s) => s.received?.key)).toEqual(["k2", "k9"]);
    expect(result.current.song?.received?.key).toBe("k2");
    expect(result.current.song?.mix.tracks[0]?.mute).toBe(true);
  });

  it("opens the tab anew when the tab it should replace was closed", async () => {
    const { result } = renderHook(() => useScoreDocuments());
    await act(() =>
      result.current.openReceived(
        { score: practiceScore, name: "Riff", key: "k2", from: "Mark" },
        { replaceId: 999 },
      ),
    );
    expect(result.current.songs).toHaveLength(1);
  });
});
