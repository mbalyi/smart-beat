/**
 * The lanes controller in a Practice together session: what this player changes is sent to the
 * others a moment later, what the others send is applied without an undo step of this player's,
 * and undo takes back only this player's own edits.
 */
import { act } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useAudioLanes, type AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import {
  diffAudio,
  type AudioOp,
  type LaneBridge,
  type LaneSharing,
} from "@/lib/audio-lanes/collab";
import { updateLane } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { mixerReducer } from "@/lib/score/mixer";
import type { AudioLanesSettings, MixerSettings, SourceInfo } from "@/lib/tauri";
import { renderWithProviders } from "@/test/render";

const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };
const info = (id: string): SourceInfo => ({
  id,
  name: "take.wav",
  ext: "wav",
  durationMs: 4000,
  sampleRate: 44_100,
  channels: 2,
  peaks: [0.5],
  peaksPerSecond: 1,
});

const latest: { lanes: AudioLanesController | null; bridge: LaneBridge | null } = {
  lanes: null,
  bridge: null,
};
const lanesNow = () => latest.lanes!;

const start = (): AudioLanesSettings => ({
  ...EMPTY_AUDIO,
  sources: [SOURCE],
  lanes: [
    { ...newLane("Vocals", "lane-a"), clips: [newClip(SOURCE.id, "take.wav", 0, 4000, "clip-a")] },
    { ...newLane("Bass", "lane-b"), clips: [] },
  ],
});

function Lanes({ sharing, loadSource }: { sharing: LaneSharing; loadSource?: () => never }) {
  const [mix, setMix] = useState<MixerSettings>({
    version: 3,
    master: 1,
    tracks: [],
    audio: start(),
  });
  const lanes = useAudioLanes({
    mix,
    changeMix: (action) => setMix((m) => mixerReducer(m, action)),
    sharing,
    songPath: null,
    grid,
    loadSource: loadSource ?? (() => Promise.resolve(info(SOURCE.id))),
  });
  useEffect(() => {
    latest.lanes = lanes;
  });
  return null;
}

function setup(options: { blocked?: boolean; waiting?: string[] } = {}) {
  const sent: AudioOp[][] = [];
  const sharing: LaneSharing = {
    active: true,
    send: (ops) => (sent.push(ops), true),
    blocked: () => options.blocked ?? false,
    attach: (bridge) => {
      latest.bridge = bridge;
    },
    waiting: new Set(options.waiting ?? []),
  };
  renderWithProviders(<Lanes sharing={sharing} />);
  return { sent };
}

const later = (ms = 150) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe("useAudioLanes in a Practice together session", () => {
  it("sends what this player changes of the shared lanes, once, a moment later", async () => {
    const { sent } = setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Lead" })));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Lead vox" })));
    await later();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([{ t: "a-lane-set", id: "lane-a", set: { name: "Lead vox" } }]);
  });

  it("sends nothing for this player's own mix", async () => {
    const { sent } = setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { volume: 0.1, mute: true })));
    await later();
    expect(sent).toEqual([]);
  });

  it("applies the others' operations without an undo step and without sending them back", async () => {
    const { sent } = setup();
    await act(async () => latest.bridge!.begin(true));
    const theirs = updateLane(lanesNow().audio, "lane-b", { name: "Keys" });
    act(() => {
      expect(latest.bridge!.apply(diffAudio(lanesNow().audio, theirs), false)).toBe(true);
    });
    expect(lanesNow().audio.lanes[1]!.name).toBe("Keys");
    expect(lanesNow().canUndo).toBe(false);
    await later();
    expect(sent).toEqual([]);
  });

  it("keeps this player's mix of a lane when the others change it", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { volume: 0.2, mute: true })));
    const theirs = updateLane(lanesNow().audio, "lane-a", { name: "Lead" });
    act(() => void latest.bridge!.apply(diffAudio(lanesNow().audio, theirs), false));
    expect(lanesNow().audio.lanes[0]).toMatchObject({ name: "Lead", volume: 0.2, mute: true });
  });

  it("undo takes back only this player's own edit and leaves the others' edits", async () => {
    const { sent } = setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Mine" })));
    await later();
    sent.length = 0;
    // Another player edits another lane, then this player undoes.
    const theirs = updateLane(lanesNow().audio, "lane-b", { name: "Theirs" });
    act(() => void latest.bridge!.apply(diffAudio(lanesNow().audio, theirs), false));
    expect(lanesNow().canUndo).toBe(true);
    act(() => void lanesNow().undo());
    expect(lanesNow().audio.lanes.map((l) => l.name)).toEqual(["Vocals", "Theirs"]);
    await later();
    expect(sent).toEqual([[{ t: "a-lane-set", id: "lane-a", set: { name: "Vocals" } }]]);
    // And redo does it again.
    act(() => void lanesNow().redo());
    expect(lanesNow().audio.lanes.map((l) => l.name)).toEqual(["Mine", "Theirs"]);
  });

  it("a drag is one undo step", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => {
      lanesNow().beginGesture();
      lanesNow().applyQuiet((a) => updateLane(a, "lane-a", { name: "1" }));
      lanesNow().applyQuiet((a) => updateLane(a, "lane-a", { name: "2" }));
    });
    act(() => void lanesNow().undo());
    expect(lanesNow().audio.lanes[0]!.name).toBe("Vocals");
    expect(lanesNow().canUndo).toBe(false);
  });

  it("skips the echo of this player's own edit while newer changes are not sent yet", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "First" })));
    await later();
    const echo = diffAudio(start(), updateLane(start(), "lane-a", { name: "First" }));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Second" })));
    // The echo of "First" arrives while "Second" is not sent: it must not bring "First" back.
    act(() => void latest.bridge!.apply(echo, true));
    expect(lanesNow().audio.lanes[0]!.name).toBe("Second");
  });

  it("refuses a batch that is not valid and says so", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    let ok = true;
    act(() => {
      ok = latest.bridge!.apply([{ t: "a-lane-del", id: "../x" }], false);
    });
    expect(ok).toBe(false);
    expect(lanesNow().audio.lanes).toHaveLength(2);
  });

  it("makes no edit while the session does not let this player edit", async () => {
    const { sent } = setup({ blocked: true });
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "No" })));
    await later();
    expect(lanesNow().audio.lanes[0]!.name).toBe("Vocals");
    expect(sent).toEqual([]);
    expect(lanesNow().undo()).toBe(false);
  });

  it("does not open a file another player is still sending", async () => {
    const loadSource = vi.fn(() => Promise.resolve(info(SOURCE.id)));
    const sharing: LaneSharing = {
      active: true,
      send: () => true,
      blocked: () => false,
      attach: () => {},
      waiting: new Set([SOURCE.id]),
    };
    renderWithProviders(<Lanes sharing={sharing} loadSource={loadSource as never} />);
    await later(50);
    expect(loadSource).not.toHaveBeenCalled();
  });

  it("after the session ends, undo is the lanes' own history again", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "In session" })));
    act(() => latest.bridge!.end());
    expect(lanesNow().canUndo).toBe(false);
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Alone" })));
    expect(lanesNow().canUndo).toBe(true);
    act(() => void lanesNow().undo());
    expect(lanesNow().audio.lanes[0]!.name).toBe("In session");
  });

  it("undo of a deleted lane brings it back with its own mix, not the defaults", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { volume: 0.25, mute: true })));
    await later();
    act(() => lanesNow().apply((a) => ({ ...a, lanes: a.lanes.filter((l) => l.id !== "lane-a") })));
    await later();
    expect(lanesNow().audio.lanes.map((l) => l.id)).toEqual(["lane-b"]);
    act(() => void lanesNow().undo());
    const back = lanesNow().audio.lanes.find((l) => l.id === "lane-a")!;
    expect(back).toMatchObject({ name: "Vocals", volume: 0.25, mute: true });
    expect(back.clips.map((c) => c.id)).toEqual(["clip-a"]);
  });

  it("an edit of only this player's own mix is an undo step of its own", async () => {
    setup();
    await act(async () => latest.bridge!.begin(true));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Shared edit" })));
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { volume: 0.1, collapsed: true })));
    expect(lanesNow().canUndo).toBe(true);
    // The first Undo takes back the mix change (the last thing done), not the name.
    act(() => void lanesNow().undo());
    expect(lanesNow().audio.lanes[0]).toMatchObject({ name: "Shared edit", volume: 0.8 });
    expect(lanesNow().audio.lanes[0]!.collapsed).toBe(false);
    act(() => void lanesNow().undo());
    expect(lanesNow().audio.lanes[0]!.name).toBe("Vocals");
    act(() => void lanesNow().redo());
    act(() => void lanesNow().redo());
    expect(lanesNow().audio.lanes[0]).toMatchObject({ volume: 0.1, collapsed: true });
  });

  it("ends with the host's order after an echo that comes while newer changes are not sent", async () => {
    const { sent } = setup();
    await act(async () => latest.bridge!.begin(true));
    // This player renames the lane (sent), another player's rename comes in between, then this
    // player changes the colour (not sent yet) and the echo of the first rename arrives.
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { name: "Mine" })));
    await later();
    const mineEcho = sent[0]!;
    const theirs = updateLane(lanesNow().audio, "lane-a", { name: "Theirs" });
    act(() => void latest.bridge!.apply(diffAudio(lanesNow().audio, theirs), false));
    expect(lanesNow().audio.lanes[0]!.name).toBe("Theirs");
    act(() => lanesNow().apply((a) => updateLane(a, "lane-a", { color: "#00ff00" })));
    act(() => void latest.bridge!.apply(mineEcho, true));
    // The host ordered "Theirs" and then "Mine": everyone else ends with "Mine", and so does this
    // player, with the colour not sent yet kept.
    expect(lanesNow().audio.lanes[0]).toMatchObject({ name: "Mine", color: "#00ff00" });
    sent.length = 0;
    await later();
    expect(sent).toEqual([[{ t: "a-lane-set", id: "lane-a", set: { color: "#00ff00" } }]]);
  });
});
