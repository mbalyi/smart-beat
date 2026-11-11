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

describe("bandRows", () => {
  it("lists every lane in order, with its place among all the lanes", () => {
    const rows = bandRows(audio([newLane("A", "a"), newLane("B", "b")]));
    expect(rows.map((r) => [r.lane.id, r.index])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("skips a hidden lane but keeps the place of the others", () => {
    const rows = bandRows(
      audio([newLane("A", "a"), { ...newLane("B", "b"), hiddenInScore: true }, newLane("C", "c")]),
    );
    expect(rows.map((r) => [r.lane.id, r.index])).toEqual([
      ["a", 0],
      ["c", 2],
    ]);
  });

  it("treats hiddenInScore false like absent", () => {
    expect(ids([{ ...newLane("A", "a"), hiddenInScore: false }])).toEqual(["a"]);
  });

  it("shows a folder header only while one of its lanes is shown", () => {
    const lanes = [folder("f"), inside("x", "f", { hiddenInScore: true }), inside("y", "f")];
    expect(ids(lanes)).toEqual(["f", "y"]);
    expect(ids([folder("f"), inside("x", "f", { hiddenInScore: true })])).toEqual([]);
  });

  it("keeps a closed folder's header while a lane inside is shown, and drops the lanes", () => {
    expect(ids([folder("f", { collapsed: true }), inside("x", "f")])).toEqual(["f"]);
    const allHidden = [folder("f", { collapsed: true }), inside("x", "f", { hiddenInScore: true })];
    expect(ids(allHidden)).toEqual([]);
  });

  it("hides the lanes inside a hidden folder with it", () => {
    const lanes = [folder("f", { hiddenInScore: true }), inside("x", "f"), newLane("Z", "z")];
    expect(ids(lanes)).toEqual(["z"]);
  });

  it("keeps the header of a folder that has no lanes yet", () => {
    expect(ids([folder("f")])).toEqual(["f"]);
  });
});

describe("hasBandRows", () => {
  it("is false for no lanes and when every lane is hidden", () => {
    expect(hasBandRows(audio([]))).toBe(false);
    expect(hasBandRows(audio([{ ...newLane("A", "a"), hiddenInScore: true }]))).toBe(false);
    expect(hasBandRows(audio([newLane("A", "a")]))).toBe(true);
  });
});
