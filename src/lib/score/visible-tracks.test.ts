import type { Track } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { moveTrack } from "@/lib/score/tracks";
import {
  moveInStack,
  reconcileStack,
  stackFromIndexes,
  stackToIndexes,
  toggleInStack,
} from "@/lib/score/visible-tracks";
import { fixtureBytes } from "@/test/score";

const load = () => {
  const score = parseScore(fixtureBytes("practice-song.gp")).score;
  const [guitar, bass, drums] = score.tracks as [Track, Track, Track];
  return { score, guitar, bass, drums };
};

describe("the tracks stacked in the continuous view", () => {
  it("adds a track after the others and takes it out again", () => {
    const { guitar, bass, drums } = load();

    const two = toggleInStack([guitar], drums, guitar);
    expect(two).toEqual([guitar, drums]);
    expect(toggleInStack(two, bass, guitar)).toEqual([guitar, drums, bass]);
    expect(toggleInStack(two, drums, guitar)).toEqual([guitar]);
  });

  it("never takes out the track being edited", () => {
    const { guitar, bass } = load();

    expect(toggleInStack([guitar, bass], guitar, guitar)).toEqual([guitar, bass]);
  });

  it("moves a stacked track without leaving the ends", () => {
    const { guitar: a, bass: b, drums: c } = load();

    expect(moveInStack([a, b, c], c, -1)).toEqual([a, c, b]);
    expect(moveInStack([a, b, c], a, 1)).toEqual([b, a, c]);
    expect(moveInStack([a, b, c], a, -1)).toEqual([a, b, c]);
    expect(moveInStack([a, b, c], c, 5)).toEqual([a, b, c]);
    expect(moveInStack([a, b], c, 1)).toEqual([a, b]);
  });

  it("keeps the order apart from the order of the tracks in the file", () => {
    const { score, guitar, bass, drums } = load();
    const stack = [drums, guitar, bass];

    expect(stackToIndexes(stack, score.tracks)).toEqual([2, 0, 1]);
    // The file order changes; the stack follows the tracks, not their places.
    moveTrack(score, 0, 3);
    expect(stackToIndexes(stack, score.tracks)).toEqual([1, 3, 0]);
  });

  it("drops tracks that are gone, repeats and adds the active track", () => {
    const { score, guitar, bass, drums } = load();

    expect(reconcileStack([bass, bass, drums], score.tracks, bass)).toEqual([bass, drums]);
    expect(reconcileStack([bass, drums], score.tracks, guitar)).toEqual([guitar, bass, drums]);
    expect(reconcileStack([], score.tracks, guitar)).toEqual([guitar]);
    expect(reconcileStack([guitar, bass], score.tracks.slice(1), bass)).toEqual([bass]);
  });

  it("restores saved indexes, ignoring wrong or repeated ones", () => {
    const { score, guitar, bass, drums } = load();

    expect(stackFromIndexes([2, 0, 2, 99, -1], score.tracks, guitar)).toEqual([drums, guitar]);
    expect(stackFromIndexes([2], score.tracks, bass)).toEqual([bass, drums]);
    expect(stackFromIndexes([], score.tracks, guitar)).toEqual([guitar]);
  });
});
