/**
 * Splits one big insert into several small ones, so an edit like pasting eight bars fits the
 * frames a session sends. An insert of a bar line or a track carries everything inside it; the
 * same result comes from inserting it empty and then inserting its voices, beats and notes one by
 * one (applied together, before the model is finished, so the empty stage is never seen).
 */
import type { Node, Op } from "@/lib/score/ops/types";

type Insert = Extract<Op, { t: "ins" }>;

/** Inserts for the voices, beats and notes inside a bar (the bar itself exists). */
function barContent(bar: Node): Insert[] {
  const ops: Insert[] = [];
  (bar.c ?? []).forEach((voice, v) => {
    ops.push({
      t: "ins",
      k: "voice",
      p: bar.u,
      a: bar.c?.[v - 1]?.u ?? null,
      d: { ...voice, c: [] },
    });
    (voice.c ?? []).forEach((beat, b) => {
      ops.push({
        t: "ins",
        k: "beat",
        p: voice.u,
        a: voice.c?.[b - 1]?.u ?? null,
        d: { ...beat, c: [] },
      });
      (beat.c ?? []).forEach((note, n) => {
        ops.push({ t: "ins", k: "note", p: beat.u, a: beat.c?.[n - 1]?.u ?? null, d: note });
      });
    });
  });
  return ops;
}

const empty = (bar: Node): Node => ({ ...bar, c: [] });

/** The operations that do what `op` does, in small pieces (just `op` when it is not a big insert). */
export function explode(op: Op): Op[] {
  if (op.t !== "ins") return [op];
  if (op.k === "mbar") {
    const bars = op.d.c ?? [];
    return [{ ...op, d: { ...op.d, c: bars.map(empty) } }, ...bars.flatMap(barContent)];
  }
  if (op.k === "track") {
    const staves = op.d.c ?? [];
    const shell: Node = {
      ...op.d,
      c: staves.map((staff) => ({ ...staff, c: (staff.c ?? []).map(empty) })),
    };
    return [{ ...op, d: shell }, ...staves.flatMap((staff) => (staff.c ?? []).flatMap(barContent))];
  }
  if (op.k === "voice" || op.k === "beat") {
    // A voice or beat with a lot inside: its parts go in after it.
    const inner = (op.d.c ?? []).flatMap((child, i) => {
      const ops: Insert[] = [];
      if (op.k === "voice") {
        ops.push({
          t: "ins",
          k: "beat",
          p: op.d.u,
          a: op.d.c?.[i - 1]?.u ?? null,
          d: { ...child, c: [] },
        });
        (child.c ?? []).forEach((note, n) =>
          ops.push({ t: "ins", k: "note", p: child.u, a: child.c?.[n - 1]?.u ?? null, d: note }),
        );
      } else {
        ops.push({ t: "ins", k: "note", p: op.d.u, a: op.d.c?.[i - 1]?.u ?? null, d: child });
      }
      return ops;
    });
    return [{ ...op, d: { ...op.d, c: [] } }, ...inner];
  }
  return [op];
}
