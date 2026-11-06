/**
 * Practice together: the messages two apps send each other. Each one is a small JSON object
 * in a frame; the transport (a LAN socket or a WebRTC data channel) only carries the text.
 */

/** The protocol this build speaks; the lower of the two apps' versions is used. */
export const PROTOCOL_VERSION = 1;
/** Frames longer than this are refused. */
export const MAX_FRAME_CHARS = 16 * 1024;

/** What this app can do, so a newer app can talk to an older one. */
export const CAPABILITIES = ["transport", "metronome", "speed", "loop"] as const;

/** Which score a peer has open. Two apps only start together on the same one. */
export interface ScoreFingerprint {
  /** SHA-256 of the file, or of the exported tab when it has unsaved edits. */
  key: string;
  bars: number;
}

export type TransportAction = "play" | "pause" | "stop" | "seek" | "settings";

/** What a scheduled command carries: the shared transport state after it happens. */
export interface Command {
  /** Identifies the command, so answers can be matched. */
  id: number;
  action: TransportAction;
  /** Where the score stands (alphaTab ticks) when the command takes effect. */
  tick: number;
  /** The host's clock when the command takes effect. */
  at: number;
  /** Speed in percent. */
  speed: number;
  /** The loop as bar indices, or null for none. */
  loop: { from: number; to: number } | null;
  metronome: boolean;
  countIn: boolean;
  countInBeats: number;
}

export type Message =
  | {
      type: "hello";
      name: string;
      role: "host" | "guest";
      caps: string[];
      score: ScoreFingerprint;
      /** The session a guest was welcomed to, when it comes back after a dropped connection. */
      session?: string;
    }
  | { type: "welcome"; session: string; version: number; name: string }
  | { type: "refuse"; reason: RefuseReason }
  | { type: "ping"; id: number; t0: number }
  | { type: "pong"; id: number; t0: number; t1: number; t2: number }
  | { type: "cmd"; cmd: Command }
  | { type: "ready"; id: number; ok: boolean; reason?: string }
  | { type: "abort"; id: number; reason: string }
  /** The host's playback position (score milliseconds, as heard) at its clock `at`. */
  | { type: "state"; pos: number; at: number; playing: boolean }
  | { type: "report"; errorMs: number; rtt: number; driftMs: number }
  | { type: "bye"; reason: string };

export type RefuseReason = "version" | "score" | "declined" | "busy";

export interface Envelope {
  v: number;
  /** A counter per sender, for ordering and loss detection. */
  n: number;
  msg: Message;
}

export function encode(msg: Message, n: number, v: number = PROTOCOL_VERSION): string {
  return JSON.stringify({ v, n, msg } satisfies Envelope);
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const ACTIONS: readonly string[] = ["play", "pause", "stop", "seek", "settings"];

function validCommand(c: unknown): c is Command {
  if (!isObject(c)) return false;
  const loop = c.loop;
  return (
    isNumber(c.id) &&
    isString(c.action) &&
    ACTIONS.includes(c.action) &&
    isNumber(c.tick) &&
    isNumber(c.at) &&
    isNumber(c.speed) &&
    (loop === null || (isObject(loop) && isNumber(loop.from) && isNumber(loop.to))) &&
    typeof c.metronome === "boolean" &&
    typeof c.countIn === "boolean" &&
    isNumber(c.countInBeats)
  );
}

function validMessage(m: unknown): m is Message {
  if (!isObject(m) || !isString(m.type)) return false;
  switch (m.type) {
    case "hello": {
      const score = m.score;
      return (
        isString(m.name) &&
        (m.role === "host" || m.role === "guest") &&
        Array.isArray(m.caps) &&
        m.caps.every(isString) &&
        isObject(score) &&
        isString(score.key) &&
        isNumber(score.bars) &&
        (m.session === undefined || isString(m.session))
      );
    }
    case "welcome":
      return isString(m.session) && isNumber(m.version) && isString(m.name);
    case "refuse":
      return isString(m.reason);
    case "ping":
      return isNumber(m.id) && isNumber(m.t0);
    case "pong":
      return isNumber(m.id) && isNumber(m.t0) && isNumber(m.t1) && isNumber(m.t2);
    case "cmd":
      return validCommand(m.cmd);
    case "ready":
      return isNumber(m.id) && typeof m.ok === "boolean";
    case "abort":
      return isNumber(m.id) && isString(m.reason);
    case "state":
      return isNumber(m.pos) && isNumber(m.at) && typeof m.playing === "boolean";
    case "report":
      return isNumber(m.errorMs) && isNumber(m.rtt) && isNumber(m.driftMs);
    case "bye":
      return isString(m.reason);
    default:
      return false;
  }
}

/** Reads a frame. Anything malformed, oversized or unknown is dropped (null), never thrown. */
export function decode(text: string): Envelope | null {
  if (text.length > MAX_FRAME_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || !isNumber(value.v) || !isNumber(value.n)) return null;
  if (!validMessage(value.msg)) return null;
  return { v: value.v, n: value.n, msg: value.msg };
}

/** The version two apps speak: the lower one. */
export const negotiate = (mine: number, theirs: number): number => Math.min(mine, theirs);
