import { model } from "@coderline/alphatab";

import { writeGp7 } from "@/lib/export/gp7";
import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import { ScoreEditor } from "@/lib/score/editor";
import { applyOps } from "@/lib/score/ops/apply";
import { assignProps, changedProps, encodeProps } from "@/lib/score/ops/codec";
import { toNode } from "@/lib/score/ops/diff";
import { explode } from "@/lib/score/ops/explode";
import { IdRegistry, subtree } from "@/lib/score/ops/ids";
import type { Op } from "@/lib/score/ops/types";
import { refinish } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { dump, practiceSong, Room } from "@/test/shared-edit";

describe("ops: ids", () => {
  it("two players who read the same file get the same ids", () => {
    const a = new IdRegistry("a");
    const b = new IdRegistry("b");
    const score = practiceSong();
    const copy = practiceSong();
    a.init(score);
    b.init(copy);
    const ids = (r: IdRegistry, s: typeof score) =>
      s.tracks.flatMap((t) => [...subtree(t)].map((part) => r.uid(part)));
    expect(ids(a, score)).toEqual(ids(b, copy));
  });

  it("the ids that differ from a fresh read are enough to line two copies up", () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    host.editor.setFret(6);
    host.editor.insertBar("after");
    host.editor.setFret(3);
    const pairs = host.sync.ids.differences(host.editor.score);
    expect(pairs.length).toBeGreaterThan(0);
    // A copy read from the file, then renamed:
    const copy = parseScore(writeGp7(host.editor.score)).score;
    const ids = new IdRegistry("late");
    ids.init(copy);
    ids.rename(copy, pairs);
    const uids = (r: IdRegistry, s: typeof copy) =>
      s.tracks.flatMap((t) => [...subtree(t)].map((part) => r.uid(part)));
    expect(uids(ids, copy)).toEqual(uids(host.sync.ids, host.editor.score));
  });

  it("forgets deleted parts, so later operations on them are dropped", () => {
    const score = practiceSong();
    const ids = new IdRegistry("p");
    ids.init(score);
    const beat = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    const uid = ids.uid(beat)!;
    applyOps(ids, score, [{ t: "del", u: uid }]);
    refinish(score);
    expect(ids.get(uid)).toBeUndefined();
    // A set on it changes nothing and does not throw.
    expect(applyOps(ids, score, [{ t: "set", u: uid, d: { dots: 1 } }])).toBe("applied");
  });
});

describe("ops: codec", () => {
  it("keeps a player's own volume, balance, mute, solo and notation out of what is shared", () => {
    const score = practiceSong();
    const track = score.tracks[0]!;
    const props = JSON.stringify(encodeProps(track));
    track.playbackInfo.isMute = !track.playbackInfo.isMute;
    track.playbackInfo.volume = 3;
    track.staves[0]!.showTablature = !track.staves[0]!.showTablature;
    expect(JSON.stringify(encodeProps(track))).toBe(props);
    expect(changedProps(encodeProps(track), encodeProps(track))).toBeNull();
  });

  it("writes properties back, bend points and all", () => {
    const score = practiceSong();
    const editor = new ScoreEditor(score);
    editor.setFret(7);
    editor.setBend([
      { offset: 0, value: 0 },
      { offset: 30, value: 4 },
    ]);
    const bent = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes.find(
      (n) => (n.bendPoints?.length ?? 0) > 0,
    )!;
    const copy = new model.Note();
    assignProps(copy, encodeProps(bent));
    expect(copy.bendPoints?.map((p) => [p.offset, p.value])).toEqual([
      [0, 0],
      [30, 4],
    ]);
  });
});

describe("ops: big inserts are split", () => {
  it("an inserted bar line taken apart gives the same bar when applied", async () => {
    const room = new Room();
    const host = room.join("host", practiceSong());
    const guest = room.join("guest", practiceSong());
    host.editor.copyBar(0);
    host.editor.pasteBarsAfter(0);
    const ops = room.log.flatMap((entry) => entry.ops);
    const big = ops.find((op) => op.t === "ins" && op.k === "mbar")!;
    const parts = explode(big);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((op) => JSON.stringify(op).length < JSON.stringify(big).length)).toBe(true);
    // Apply the pieces instead of the whole to a fresh copy:
    const other = new Room();
    const a = other.join("host", practiceSong());
    const b = other.join("guest", practiceSong());
    const exploded: Op[] = ops.flatMap((op) => explode(op));
    applyOps(b.sync.ids, b.editor.score, exploded);
    refinish(b.editor.score);
    b.sync.ids.sync(b.editor.score);
    expect((await scoreFingerprint(b.editor.score)).key).toBe(
      (await scoreFingerprint(host.editor.score)).key,
    );
    void a;
    void guest;
    void dump;
    void toNode;
  });
});
