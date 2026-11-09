/**
 * Operations: what a score edit looks like on the wire in a shared editing session.
 *
 * Every element of the score (track, staff, bar line, bar, voice, beat, note) has a stable id,
 * its `uid` (see ids.ts). An operation names its target by that id, never by position, so it
 * still means the same thing after other players inserted or deleted bars around it. Operations
 * set absolute values (never "add 2"), which keeps replaying one harmless and lets the host's
 * order decide when two players change the same value.
 */

/** A JSON-safe value (see codec.ts). */
export type Json = unknown;

/** Encoded properties of an element, by property name. */
export type Props = Record<string, Json>;

/** Elements that live in an ordered list and can be inserted and deleted on their own. */
export type Kind = "track" | "mbar" | "voice" | "beat" | "note";

/** An element and everything inside it, as sent when it is inserted. */
export interface Node {
  /** The element's uid. */
  u: string;
  /** The node's type. `staff` and `bar` only appear inside a track or a bar line node. */
  k: Kind | "staff" | "bar";
  /** The element's own properties. */
  p: Props;
  /** What it contains: staves, bars, voices, beats or notes, in order. */
  c?: Node[];
  /** For a `bar` node: the uid of the staff (inside a bar line node) or of the bar line (inside a track node) it belongs to. */
  x?: string;
}

export type Op =
  /** Inserts `d` into the list `k` of the parent `p`, right after the sibling `a` (null: first). */
  | { t: "ins"; k: Kind; p: string | null; a: string | null; d: Node }
  /** Deletes an element and everything inside it. */
  | { t: "del"; u: string }
  /** Sets some of an element's properties. */
  | { t: "set"; u: string; d: Props }
  /** The change was too large or too structural to describe: everyone must take the tab again. */
  | { t: "reset" };

/** The operations one edit made, and the ones that take it back. */
export interface Edit {
  ops: Op[];
  inverse: Op[];
}

/** Elements whose properties are a player's own, never shared: volume, balance, mute, solo and which notations show. */
export const PERSONAL = {
  playbackInfo: ["volume", "balance", "isMute", "isSolo"],
  staff: ["showTablature", "showStandardNotation", "showSlash", "showNumbered"],
} as const;
