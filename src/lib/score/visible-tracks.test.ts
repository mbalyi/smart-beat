import type { Track } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { moveTrack } from "@/lib/score/tracks";
import {
  moveInStack,
  reconcileStack,
  stackForEditing,
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
    expect(two).toEqual({ stack: [guitar, drums], active: guitar });
    expect(toggleInStack(two.stack, bass, guitar)).toEqual({
      stack: [guitar, drums, bass],
      active: guitar,
    });
    expect(toggleInStack(two.stack, drums, guitar)).toEqual({ stack: [guitar], active: guitar });
  });

  it("puts a track that is added again at the bottom", () => {
    const { guitar, bass, drums } = load();

    const out = toggleInStack([guitar, bass, drums], bass, guitar);
    expect(out.stack).toEqual([guitar, drums]);
    expect(toggleInStack(out.stack, bass, out.active).stack).toEqual([guitar, drums, bass]);
  });

  it("moves editing to the top remaining track when the edited one is taken out", () => {
    const { guitar, bass, drums } = load();

    expect(toggleInStack([guitar, bass, drums], guitar, guitar)).toEqual({
      stack: [bass, drums],
      active: bass,
    });
    expect(toggleInStack([bass, guitar, drums], guitar, guitar)).toEqual({
      stack: [bass, drums],
      active: bass,
    });
    expect(toggleInStack([drums, bass, guitar], guitar, guitar)).toEqual({
      stack: [drums, bass],
      active: drums,
    });
  });

  it("keeps the last track in the view", () => {
    const { guitar } = load();

    expect(toggleInStack([guitar], guitar, guitar)).toEqual({ stack: [guitar], active: guitar });
  });

  it("adds a track chosen for editing at the bottom instead of swapping it in", () => {
    const { guitar, bass, drums } = load();

    expect(stackForEditing([guitar, bass], drums)).toEqual([guitar, bass, drums]);
    expect(stackForEditing([guitar, bass], bass)).toEqual([guitar, bass]);
    // A single track is not a stack: the new one just takes over.
    expect(stackForEditing([guitar], drums)).toEqual([drums]);
    // Outside the continuous view the new one takes the place of the track that was edited.
    expect(stackForEditing([guitar, bass], drums, guitar)).toEqual([drums, bass]);
    expect(stackForEditing([guitar, bass], bass, guitar)).toEqual([guitar, bass]);
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
