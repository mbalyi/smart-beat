import { model } from "@coderline/alphatab";

import type { ScoreEditor } from "@/lib/score/editor";
import { dump, practiceSong, Room, type Player } from "@/test/shared-edit";

const { Duration } = model;

/** A small seeded random number generator, so a failing run can be repeated. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]) => list[Math.floor(rand() * list.length)]!;

const EDITS: ((e: ScoreEditor, n: number) => void)[] = [
  (e, n) => e.setFret(n % 20),
  (e) => e.setDuration(Duration.Eighth),
  (e) => e.toggleDots(1),
  (e) => e.insertBeat(),
  (e) => e.deleteBeats(),
  (e) => e.clearNotes(),
  (e) => e.insertBar("after"),
  (e) => void e.deleteBar(),
  (e) => e.toggleRepeat("start"),
  (e, n) => {
    e.moveString(n % 2 ? 1 : -1);
    e.setFret(3);
  },
  (e) => e.toggleNoteEffect("palmMute"),
  (e) => e.fillWithRests(),
];

function step(rand: () => number, player: Player, n: number) {
  const { editor } = player;
  const bars = editor.score.masterBars.length;
  editor.setCursorTo({ bar: Math.floor(rand() * bars), beat: 0 });
  const roll = rand();
  if (roll < 0.15) editor.undo();
  else if (roll < 0.2) editor.redo();
  else pick(rand, EDITS)(editor, n);
}

describe("shared editing: convergence", () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`three players edit at random with slow links (seed ${seed})`, () => {
      const rand = random(seed);
      const room = new Room();
      const players = [
        room.join("host", practiceSong()),
        room.join("a", practiceSong()),
        room.join("b", practiceSong()),
      ];
      for (let i = 0; i < 40; i++) {
        step(rand, pick(rand, players), i);
        const roll = rand();
        if (roll < 0.4) room.arrive();
        else if (roll < 0.7) room.deliver();
      }
      room.settle();
      expect(room.resets).toEqual([]);
      for (const player of players.slice(1)) expect(dump(player)).toEqual(dump(players[0]!));
    });
  }

  it("a player who was offline catches up with the edits they missed and sends their own", () => {
    const rand = random(99);
    const room = new Room();
    const [host, a] = [room.join("host", practiceSong()), room.join("a", practiceSong())];
    room.offline.add(a);
    for (let i = 0; i < 10; i++) {
      step(rand, host, i);
      step(rand, a, i);
      room.arrive();
      room.deliver();
    }
    room.offline.delete(a);
    room.settle();
    expect(room.resets).toEqual([]);
    expect(dump(a)).toEqual(dump(host));
  });
});
