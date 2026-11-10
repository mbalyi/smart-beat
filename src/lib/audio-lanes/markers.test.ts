import { describe, expect, it } from "vitest";

import {
  MAX_MARKERS,
  MAX_MARKER_NAME,
  MAX_REGIONS,
  addMarker,
  addRegion,
  clipsExtent,
  markerNumber,
  markersOf,
  moveMarker,
  nextMarker,
  nextMarkerName,
  normalizeMarkers,
  normalizeRegions,
  previousMarker,
  regionsOf,
  removeMarker,
  removeRegion,
  renameMarker,
  renameRegion,
} from "@/lib/audio-lanes/markers";
import { EMPTY_AUDIO, newClip, newLane, normalizeAudio } from "@/lib/audio-lanes/model";
import type { AudioLanesSettings, AudioMarker } from "@/lib/tauri";

const marker = (id: string, ms: number, name = `Marker ${id}`): AudioMarker => ({ id, ms, name });

const withMarkers = (...markers: AudioMarker[]): AudioLanesSettings => ({
  ...EMPTY_AUDIO,
  markers,
});

describe("normalizeMarkers", () => {
  it("sorts by time, drops bad positions and duplicate ids, and cuts long names", () => {
    const result = normalizeMarkers([
      marker("b", 3000),
      marker("a", 1000, "x".repeat(MAX_MARKER_NAME + 10)),
      marker("c", Number.NaN),
      marker("d", -5),
      marker("b", 50),
    ]);
    expect(result.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result[0]!.name).toHaveLength(MAX_MARKER_NAME);
  });

  it("keeps at most the cap", () => {
    const many = Array.from({ length: MAX_MARKERS + 5 }, (_, i) => marker(`m${i}`, i));
    expect(normalizeMarkers(many)).toHaveLength(MAX_MARKERS);
  });
});

describe("normalizeRegions", () => {
  it("orders each span, drops empty ones and sorts by start", () => {
    const result = normalizeRegions([
      { id: "b", startMs: 9000, endMs: 5000, name: "Verse" },
      { id: "a", startMs: 1000, endMs: 2000, name: "Intro" },
      { id: "c", startMs: 3000, endMs: 3000, name: "Empty" },
      { id: "d", startMs: 0, endMs: Number.POSITIVE_INFINITY, name: "Bad" },
    ]);
    expect(result).toEqual([
      { id: "a", startMs: 1000, endMs: 2000, name: "Intro" },
      { id: "b", startMs: 5000, endMs: 9000, name: "Verse" },
    ]);
  });

  it("keeps at most the cap", () => {
    const many = Array.from({ length: MAX_REGIONS + 1 }, (_, i) => ({
      id: `r${i}`,
      startMs: i,
      endMs: i + 1,
      name: "R",
    }));
    expect(normalizeRegions(many)).toHaveLength(MAX_REGIONS);
  });
});

describe("normalizeAudio", () => {
  it("leaves older files without markers as they were", () => {
    const audio = normalizeAudio(EMPTY_AUDIO);
    expect("markers" in audio).toBe(false);
    expect("regions" in audio).toBe(false);
  });

  it("normalises markers and regions when present", () => {
    const audio = normalizeAudio({
      ...EMPTY_AUDIO,
      markers: [marker("b", 2000), marker("a", 1000)],
      regions: [{ id: "r", startMs: 4000, endMs: 1000, name: "Solo" }],
    });
    expect(markersOf(audio).map((m) => m.id)).toEqual(["a", "b"]);
    expect(regionsOf(audio)).toEqual([{ id: "r", startMs: 1000, endMs: 4000, name: "Solo" }]);
  });
});

describe("marker edits", () => {
  it("adds markers named Marker N in time order, reusing a free number", () => {
    let audio = addMarker(EMPTY_AUDIO, 4000, "m1");
    audio = addMarker(audio, 1000, "m2");
    expect(markersOf(audio).map((m) => [m.id, m.name])).toEqual([
      ["m2", "Marker 2"],
      ["m1", "Marker 1"],
    ]);
    audio = removeMarker(audio, "m1");
    expect(nextMarkerName(audio)).toBe("Marker 1");
  });

  it("does not add past the cap or at a bad position", () => {
    const full = withMarkers(...Array.from({ length: MAX_MARKERS }, (_, i) => marker(`m${i}`, i)));
    expect(addMarker(full, 10)).toBe(full);
    expect(addMarker(EMPTY_AUDIO, Number.NaN)).toBe(EMPTY_AUDIO);
  });

  it("moves, renames and removes without touching the original", () => {
    const audio = withMarkers(marker("a", 1000), marker("b", 2000));
    const moved = moveMarker(audio, "a", 3000);
    expect(markersOf(moved).map((m) => m.id)).toEqual(["b", "a"]);
    expect(markersOf(audio)[0]!.ms).toBe(1000);
    expect(markersOf(renameMarker(audio, "a", "  Chorus  "))[0]!.name).toBe("Chorus");
    expect(renameMarker(audio, "a", "   ")).toBe(audio);
    expect(renameMarker(audio, "missing", "X")).toBe(audio);
    expect(markersOf(removeMarker(audio, "a")).map((m) => m.id)).toEqual(["b"]);
    expect(removeMarker(audio, "missing")).toBe(audio);
  });
});

describe("region edits", () => {
  it("adds a region named Region N over a span in either order", () => {
    const audio = addRegion(EMPTY_AUDIO, 6000, 2000, "r1");
    expect(regionsOf(audio)).toEqual([{ id: "r1", startMs: 2000, endMs: 6000, name: "Region 1" }]);
    expect(addRegion(EMPTY_AUDIO, 1000, 1000)).toBe(EMPTY_AUDIO);
  });

  it("renames and removes", () => {
    const audio = addRegion(EMPTY_AUDIO, 0, 1000, "r1");
    expect(regionsOf(renameRegion(audio, "r1", "Intro"))[0]!.name).toBe("Intro");
    expect(renameRegion(audio, "r1", "")).toBe(audio);
    expect(regionsOf(removeRegion(audio, "r1"))).toEqual([]);
    expect(removeRegion(audio, "nope")).toBe(audio);
  });
});

describe("stepping through markers", () => {
  const audio = withMarkers(marker("a", 1000), marker("b", 3000), marker("c", 5000));

  it("finds the previous and next marker from a point", () => {
    expect(previousMarker(audio, 3000)?.id).toBe("a");
    expect(previousMarker(audio, 1000)).toBeNull();
    expect(nextMarker(audio, 3000)?.id).toBe("c");
    expect(nextMarker(audio, 5000)).toBeNull();
    expect(nextMarker(audio, 0)?.id).toBe("a");
  });

  it("finds marker N in time order", () => {
    expect(markerNumber(audio, 2)?.id).toBe("b");
    expect(markerNumber(audio, 4)).toBeNull();
    expect(markerNumber(audio, 0)).toBeNull();
  });
});

describe("clipsExtent", () => {
  it("spans the given clips, counting the playrate", () => {
    const lane = {
      ...newLane("Vocals", "lane"),
      clips: [
        newClip("s", "a.wav", 2000, 1000, "c1"),
        { ...newClip("s", "b.wav", 5000, 2000, "c2"), playrate: 2 },
        newClip("s", "c.wav", 9000, 1000, "c3"),
      ],
    };
    const audio = { lanes: [lane] };
    expect(clipsExtent(audio, ["c1", "c2"])).toEqual({ startMs: 2000, endMs: 6000 });
    expect(clipsExtent(audio, ["missing"])).toBeNull();
  });
});
