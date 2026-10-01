import { applyTempo, beatRatio, clampTempo, tempoChangesOf, tempoMarkers } from "@/lib/score/tempo";
import { tempoAt } from "@/lib/score/structure";
import { createSong } from "@/lib/score/tracks";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";

/** A song of four bars at 100 BPM. */
function song() {
  const score = createSong();
  applyTempo(score, { scope: "song", bpm: 100 });
  return score;
}

const tempos = (score: ReturnType<typeof song>) =>
  score.masterBars.map((_, i) => tempoAt(score, i));

describe("clampTempo", () => {
  it("keeps the tempo between 10 and 400 BPM and accepts decimals", () => {
    expect(clampTempo(5)).toBe(10);
    expect(clampTempo(1_000)).toBe(400);
    expect(clampTempo(92.456)).toBe(92.46);
    expect(clampTempo(Number.NaN)).toBe(120);
  });
});

describe("applyTempo: the song's tempo", () => {
  it("sets the tempo of the first bar and keeps its label and later changes", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 2, beat: 0, bpm: 140 });
    score.masterBars[0]!.tempoAutomations[0]!.text = "Allegro";

    const touched = applyTempo(score, { scope: "song", bpm: 92.5 });

    expect(touched).toEqual({ from: 0, to: 0 });
    expect(tempos(score)).toEqual([92.5, 92.5, 140, 140]);
    expect(score.masterBars[0]!.tempoAutomations[0]!.text).toBe("Allegro");
  });
});

describe("applyTempo: a change at a bar and beat", () => {
  it("applies from that bar on, until the next change", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 1, beat: 0, bpm: 80 });
    applyTempo(score, { scope: "from", bar: 3, beat: 0, bpm: 120 });
    expect(tempos(score)).toEqual([100, 80, 80, 120]);
  });

  it("can start in the middle of a bar, at a beat", () => {
    const score = song();

    applyTempo(score, { scope: "from", bar: 1, beat: 2, bpm: 60 });

    expect(tempoChangesOf(score.masterBars[1]!)).toEqual([{ ratio: 0.5, bpm: 60, label: "" }]);
    expect(tempoAt(score, 1)).toBe(100); // the bar starts at the old tempo
    expect(tempoAt(score, 2)).toBe(60);
  });

  it("changes the tempo already at that place instead of adding a second one", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 1, beat: 0, bpm: 80 });
    applyTempo(score, { scope: "from", bar: 1, beat: 0, bpm: 90 });
    expect(tempoChangesOf(score.masterBars[1]!)).toEqual([{ ratio: 0, bpm: 90, label: "" }]);
  });

  it("treats a change at the first beat of bar 1 as the song's tempo", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 0, beat: 0, bpm: 70 });
    expect(tempoChangesOf(score.masterBars[0]!)).toEqual([{ ratio: 0, bpm: 70, label: "" }]);
  });

  it("keeps bar and beat inside the song", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 99, beat: 99, bpm: 90 });
    expect(tempoChangesOf(score.masterBars[3]!)).toEqual([{ ratio: 0.75, bpm: 90, label: "" }]);
  });
});

describe("applyTempo: a range of bars", () => {
  it("sets the tempo for those bars only; the old tempo comes back after them", () => {
    const score = song();

    const touched = applyTempo(score, { scope: "range", from: 1, to: 2, bpm: 60 });

    expect(tempos(score)).toEqual([100, 60, 60, 100]);
    expect(touched).toEqual({ from: 1, to: 3 });
  });

  it("needs no change back at the end of the song", () => {
    const score = song();
    const touched = applyTempo(score, { scope: "range", from: 2, to: 3, bpm: 60 });
    expect(tempos(score)).toEqual([100, 100, 60, 60]);
    expect(touched).toEqual({ from: 2, to: 3 });
    expect(tempoChangesOf(score.masterBars[3]!)).toEqual([]);
  });

  it("restores the tempo that was in effect after the range, not the one before", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 2, beat: 0, bpm: 140 }); // 100, 100, 140, 140

    applyTempo(score, { scope: "range", from: 1, to: 2, bpm: 60 });

    expect(tempos(score)).toEqual([100, 60, 60, 140]);
  });

  it("replaces changes inside the range, and leaves a change right after it alone", () => {
    const score = song();
    applyTempo(score, { scope: "from", bar: 1, beat: 2, bpm: 50 });
    applyTempo(score, { scope: "from", bar: 3, beat: 0, bpm: 130 });

    applyTempo(score, { scope: "range", from: 0, to: 2, bpm: 90 });

    expect(tempos(score)).toEqual([90, 90, 90, 130]);
    expect(tempoChangesOf(score.masterBars[1]!)).toEqual([]);
  });

  it("does nothing extra when the range has the tempo that follows", () => {
    const score = song();
    applyTempo(score, { scope: "range", from: 1, to: 2, bpm: 100 });
    expect(tempoChangesOf(score.masterBars[3]!)).toEqual([]);
  });

  it("puts the range's tempo on the first bar when the range starts there", () => {
    const score = song();
    applyTempo(score, { scope: "range", from: 0, to: 1, bpm: 70 });
    expect(tempos(score)).toEqual([70, 70, 100, 100]);
  });

  it("keeps the range inside the song and in order", () => {
    const score = song();
    applyTempo(score, { scope: "range", from: 2, to: 0, bpm: 60 });
    expect(tempos(score)).toEqual([100, 100, 60, 100]);
    applyTempo(score, { scope: "range", from: 3, to: 99, bpm: 80 });
    expect(tempos(score).at(-1)).toBe(80);
  });
});

describe("beatRatio", () => {
  it("is where in the bar a beat starts", () => {
    const score = song();
    const bar = score.masterBars[0]!;
    expect([0, 1, 2, 3].map((beat) => beatRatio(bar, beat))).toEqual([0, 0.25, 0.5, 0.75]);
    expect(beatRatio(bar, 9)).toBe(0.75);
    expect(beatRatio(bar, -1)).toBe(0);
  });
});

describe("tempo changes of a real song", () => {
  it("reads the 60 → 120 BPM change of the practice song, which a range can override", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    expect([0, 1, 2, 3].map((i) => tempoAt(score, i))).toEqual([60, 60, 120, 120]);

    applyTempo(score, { scope: "range", from: 1, to: 1, bpm: 90 });

    expect([0, 1, 2, 3].map((i) => tempoAt(score, i))).toEqual([60, 90, 120, 120]);
  });
});

describe("tempoMarkers", () => {
  it("lists the bars where the tempo is set, with the tempo", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    expect(tempoMarkers(score).map(({ bar, bpm }) => [bar, bpm])).toEqual([
      [0, 60],
      [2, 120],
    ]);
  });
});
