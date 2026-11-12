import { addLane } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, MAX_LANES, newLane } from "@/lib/audio-lanes/model";
import { STEM_COLOR_HEX } from "@/lib/stems/colors";
import { addStemLanes, freeLanes, stemLaneName, type StemLaneItem } from "@/lib/stems/stem-lanes";
import type { AudioLanesSettings, SourceInfo, StemKindId } from "@/lib/tauri";

const info = (kind: StemKindId, durationMs = 215_000): SourceInfo => ({
  id: kind.padEnd(64, "0"),
  name: `${kind} - Song.wav`,
  ext: "wav",
  durationMs,
  sampleRate: 44_100,
  channels: 2,
  peaks: [0.5],
  peaksPerSecond: 20,
});
const items = (...kinds: StemKindId[]): StemLaneItem[] =>
  kinds.map((kind) => ({ kind, info: info(kind) }));

const SONG = { engine: "htdemucs" } as const;

describe("stem lanes", () => {
  it("names a lane after the stem and the model variant", () => {
    expect(stemLaneName("vocals", { engine: "scnet-xl" })).toBe("Vocals · SCNet XL");
    expect(stemLaneName("guitar", { engine: "htdemucs-6s" })).toMatch(/^Guitar · /);
    // The fast engine does not separate "other", and the lane says so.
    expect(stemLaneName("other", { engine: "fast" })).toBe("Other (not separated) · Fast");
  });

  it("adds a lane per stem with one clip that plays the whole stem from the start", () => {
    const audio = addStemLanes(EMPTY_AUDIO, SONG, items("drums", "bass", "vocals"));
    expect(audio.lanes.map((l) => l.name)).toEqual([
      "Drums · HTDemucs",
      "Bass · HTDemucs",
      "Vocals · HTDemucs",
    ]);
    expect(audio.lanes.map((l) => l.color)).toEqual([
      STEM_COLOR_HEX.drums,
      STEM_COLOR_HEX.bass,
      STEM_COLOR_HEX.vocals,
    ]);
    for (const lane of audio.lanes) {
      expect(lane.clips).toHaveLength(1);
      expect(lane.clips[0]).toMatchObject({ startMs: 0, lengthMs: 215_000, playrate: 1 });
      expect(lane.clips[0]!.takes).toHaveLength(1);
    }
    // Each clip plays its own source, and the sources are embedded (they have no file path).
    expect(audio.lanes.map((l) => l.clips[0]!.takes[0]!.sourceId)).toEqual(
      audio.sources.map((s) => s.id),
    );
    expect(audio.sources).toEqual([
      { id: info("drums").id, name: "drums - Song.wav", ext: "wav", embedded: true },
      { id: info("bass").id, name: "bass - Song.wav", ext: "wav", embedded: true },
      { id: info("vocals").id, name: "vocals - Song.wav", ext: "wav", embedded: true },
    ]);
    expect(audio.sources.every((s) => s.path === undefined)).toBe(true);
  });

  it("keeps the other lanes, sources and settings of the song as they are", () => {
    const own = newLane("Backing track", "own");
    const before: AudioLanesSettings = {
      ...addLane(EMPTY_AUDIO, own),
      sync: [{ ms: 0, bar: 0 }] as AudioLanesSettings["sync"],
      ripple: "lane",
    };
    const after = addStemLanes(before, SONG, items("bass"));
    expect(after.lanes[0]).toBe(own);
    expect(after.lanes).toHaveLength(2);
    expect(after.sync).toBe(before.sync);
    expect(after.ripple).toBe("lane");
    expect(before.lanes).toHaveLength(1);
  });

  it("adds a source once when two lanes play the same file", () => {
    const same: StemLaneItem[] = [
      { kind: "drums", info: info("drums") },
      { kind: "bass", info: info("drums") },
    ];
    const audio = addStemLanes(EMPTY_AUDIO, SONG, same);
    expect(audio.sources).toHaveLength(1);
    expect(audio.lanes).toHaveLength(2);
  });

  it("adds nothing when they would not all fit, and counts the free lanes", () => {
    let full = EMPTY_AUDIO;
    for (let i = 0; i < MAX_LANES - 2; i += 1) full = addLane(full, newLane(`Lane ${i}`));
    expect(freeLanes(full)).toBe(2);
    expect(addStemLanes(full, SONG, items("drums", "bass", "vocals"))).toBe(full);
    expect(addStemLanes(full, SONG, items("drums", "bass")).lanes).toHaveLength(MAX_LANES);
    expect(freeLanes(addStemLanes(full, SONG, items("drums", "bass")))).toBe(0);
    expect(addStemLanes(EMPTY_AUDIO, SONG, [])).toBe(EMPTY_AUDIO);
  });
});
