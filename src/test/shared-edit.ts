/**
 * Test harness for shared editing: several editors on copies of one tab, joined by a host that
 * puts their operations in one order, with delivery the test controls (to try slow links).
 */
import { ScoreEditor } from "@/lib/score/editor";
import { EditSync } from "@/lib/score/ops/collab";
import type { Op } from "@/lib/score/ops/types";
import { toNode } from "@/lib/score/ops/diff";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";
import type { Score } from "@/lib/score/model";

export interface Player {
  name: string;
  editor: ScoreEditor;
  sync: EditSync;
}

interface Delivery {
  to: Player;
  ops: Op[];
  echo: boolean;
}

export class Room {
  readonly players: Player[] = [];
  /** Operations on their way to a player, in the order the host sent them. */
  private queue: Delivery[] = [];
  /** Operations a guest sent that the host has not received yet. */
  private upstream: { from: Player; ops: Op[] }[] = [];
  /** Players whose link is down: nothing reaches them. */
  readonly offline = new Set<Player>();
  seq = 0;
  /** Every operation batch in the host's order. */
  readonly log: { seq: number; from: string; ops: Op[] }[] = [];
  /** Edits that could not be described (the app would send the whole tab again). */
  readonly resets: string[] = [];

  /** The host is the first player. */
  join(name: string, score: Score, track = 0): Player {
    const editor = new ScoreEditor(score, track);
    const isHost = this.players.length === 0;
    const player = { name, editor } as Player;
    player.sync = new EditSync(
      editor,
      {
        send: (ops) => {
          if (isHost) this.sequence(player, ops);
          else this.upstream.push({ from: player, ops });
        },
        reset: () => this.resets.push(name),
      },
      name,
      undefined,
      isHost,
    );
    player.sync.attach();
    this.players.push(player);
    return player;
  }

  get host(): Player {
    return this.players[0]!;
  }

  /** The host receives a guest's batch: applies it, orders it, and sends it on. */
  private sequence(from: Player, ops: Op[]) {
    const host = this.host;
    if (from !== host) host.sync.receive(ops, false);
    this.seq++;
    this.log.push({ seq: this.seq, from: from.name, ops });
    for (const to of this.players) {
      if (to === host) continue;
      this.queue.push({ to, ops, echo: to === from });
    }
  }

  /** Guests' batches reach the host. */
  arrive(): void {
    const batches = this.upstream.splice(0);
    for (const { from, ops } of batches) {
      if (this.offline.has(from)) this.upstream.push({ from, ops });
      else this.sequence(from, ops);
    }
  }

  /** Delivers everything the host sent, in order. */
  deliver(): void {
    const queue = this.queue.splice(0);
    for (const { to, ops, echo } of queue) {
      if (this.offline.has(to)) this.queue.push({ to, ops, echo });
      else to.sync.receive(ops, echo);
    }
  }

  /** Everything is delivered until nothing is on its way. */
  settle(): void {
    for (let i = 0; i < 20 && (this.upstream.length > 0 || this.queue.length > 0); i++) {
      this.arrive();
      this.deliver();
    }
  }
}

/** Everything in a score that is shared, as comparable data. */
export function dump(player: Player): unknown {
  const { ids } = player.sync;
  const score = player.editor.score;
  return {
    masterBars: score.masterBars.map((masterBar) => toNode(ids, masterBar).p),
    tracks: score.tracks.map((track) => toNode(ids, track)),
  };
}

/** A copy of the practice song: every player opens the same file. */
export const practiceSong = () => parseScore(fixtureBytes("practice-song.gp")).score;
