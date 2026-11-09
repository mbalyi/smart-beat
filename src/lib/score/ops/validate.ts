/**
 * Checks operations that come from another computer before they touch the score. A modified or
 * buggy app could send anything, and an operation that throws half way would leave the host's
 * score changed and unpublished, so the shape, the sizes and the nesting are checked first.
 */
import type { Kind, Node, Op } from "@/lib/score/ops/types";

const MAX_ID = 200;
const MAX_NODES = 20_000;
const MAX_DEPTH = 40;
const MAX_KEYS = 400;

const KINDS: readonly string[] = ["track", "mbar", "voice", "beat", "note"];
/** What each node may contain. */
const CHILDREN: Record<string, string | null> = {
  track: "staff",
  staff: "bar",
  mbar: "bar",
  bar: "voice",
  voice: "beat",
  beat: "note",
  note: null,
};

/** Keys that would change an object's type or reach into every object of a class. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
const isIdOrNull = (value: unknown): boolean => value === null || isId(value);

/** Whether a JSON value is no deeper than `limit`, counting what it holds into `budget`. */
function shallow(value: unknown, limit: number, budget: { left: number }): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (limit <= 0 || (budget.left -= 1) < 0) return false;
  if (Array.isArray(value)) return value.every((item) => shallow(item, limit - 1, budget));
  return Object.entries(value).every(
    ([key, item]) => !FORBIDDEN_KEYS.has(key) && shallow(item, limit - 1, budget),
  );
}

/** Properties of an element: a plain object whose values are not nested too deep. */
function validProps(props: unknown, budget: { left: number }): boolean {
  if (!isObject(props)) return false;
  const keys = Object.keys(props);
  if (keys.length > MAX_KEYS || keys.some((key) => FORBIDDEN_KEYS.has(key))) return false;
  return shallow(props, MAX_DEPTH, budget);
}

function validNode(node: unknown, kind: string, depth: number, budget: { left: number }): boolean {
  if (!isObject(node) || depth > 8 || (budget.left -= 1) < 0) return false;
  if (!isId(node.u) || node.k !== kind || !validProps(node.p, budget)) return false;
  if (node.x !== undefined && !isId(node.x)) return false;
  const child = CHILDREN[kind];
  if (node.c === undefined) return true;
  if (!Array.isArray(node.c) || child === null || child === undefined) return false;
  return node.c.every((inner) => validNode(inner, child, depth + 1, budget));
}

/** The operations if they are well formed; null when any of them is not. */
export function validOps(ops: unknown): Op[] | null {
  if (!Array.isArray(ops) || ops.length > 4000) return null;
  const budget = { left: MAX_NODES };
  for (const op of ops as unknown[]) {
    if (!isObject(op)) return null;
    switch (op.t) {
      case "reset":
        break;
      case "del":
        if (!isId(op.u)) return null;
        break;
      case "set":
        if (!isId(op.u) || !validProps(op.d, budget)) return null;
        break;
      case "ins":
        if (
          typeof op.k !== "string" ||
          !KINDS.includes(op.k) ||
          !isIdOrNull(op.p) ||
          !isIdOrNull(op.a) ||
          (op.b !== undefined && !isIdOrNull(op.b)) ||
          !validNode(op.d, op.k as Kind, 0, budget)
        ) {
          return null;
        }
        // Voices, beats and notes go into a parent; bar lines and tracks into the score.
        if (
          (op.k === "voice" || op.k === "beat" || op.k === "note") !==
          (typeof op.p === "string")
        ) {
          return null;
        }
        break;
      default:
        return null;
    }
  }
  return ops as Op[];
}

export type { Node };
