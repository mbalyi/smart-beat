import { describe, expect, it } from "vitest";

import { bandRows, hasBandRows } from "@/lib/audio-lanes/band-rows";
import { EMPTY_AUDIO, newLane } from "@/lib/audio-lanes/model";
import type { AudioLane } from "@/lib/tauri";

const audio = (lanes: AudioLane[]) => ({ ...EMPTY_AUDIO, lanes });
const ids = (lanes: AudioLane[]) => bandRows(audio(lanes)).map((r) => r.lane.id);
const folder = (id: string, extra: Partial<AudioLane> = {}): AudioLane => ({
  ...newLane(id, id),
  folder: true,
  ...extra,
});
const inside = (id: string, parent: string, extra: Partial<AudioLane> = {}): AudioLane => ({
  ...newLane(id, id),
  parent,
  ...extra,
});

const shown = (lane: AudioLane): AudioLane => ({ ...lane, shownInScore: true });

describe("bandRows", () => {
  it("lists the shown lanes in order, with their place among all the lanes", () => {
    const rows = bandRows(
      audio([shown(newLane("A", "a")), newLane("B", "b"), shown(newLane("C", "c"))]),
    );
    expect(rows.map((r) => [r.lane.id, r.index])).toEqual([
      ["a", 0],
      ["c", 2],
    ]);
  });

  it("shows no lane by default", () => {
    expect(ids([newLane("A", "a"), newLane("B", "b")])).toEqual([]);
  });

  it("treats shownInScore false like absent", () => {
    expect(ids([{ ...newLane("A", "a"), shownInScore: false }])).toEqual([]);
  });

  it("shows a folder header only while one of its lanes is shown", () => {
    const lanes = [folder("f"), inside("x", "f"), inside("y", "f", { shownInScore: true })];
    expect(ids(lanes)).toEqual(["f", "y"]);
    expect(ids([folder("f"), inside("x", "f")])).toEqual([]);
  });

  it("keeps a closed folder's header while a lane inside is shown, and drops the lanes", () => {
    expect(
      ids([folder("f", { collapsed: true }), inside("x", "f", { shownInScore: true })]),
    ).toEqual(["f"]);
    expect(ids([folder("f", { collapsed: true }), inside("x", "f")])).toEqual([]);
  });

  it("ignores the flag on a folder itself: it follows the lanes inside", () => {
    expect(ids([folder("f", { shownInScore: true }), inside("x", "f")])).toEqual([]);
  });

  it("keeps no header for a folder that has no lanes yet", () => {
    expect(ids([folder("f")])).toEqual([]);
  });
});

describe("hasBandRows", () => {
  it("is false for no lanes and when no lane is shown, true once one is", () => {
    expect(hasBandRows(audio([]))).toBe(false);
    expect(hasBandRows(audio([newLane("A", "a")]))).toBe(false);
    expect(hasBandRows(audio([shown(newLane("A", "a"))]))).toBe(true);
  });
});
