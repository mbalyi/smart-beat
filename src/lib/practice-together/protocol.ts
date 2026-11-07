/**
 * Practice together: the messages two apps send each other. Each one is a small JSON object
 * in a frame; the transport (a LAN socket or a WebRTC data channel) only carries the text.
 */

/** The protocol this build speaks; the lower of the two apps' versions is used. */
export const PROTOCOL_VERSION = 1;
/** Frames longer than this are refused. */
export const MAX_FRAME_CHARS = 16 * 1024;

/** What this app can do, so a newer app can talk to an older one. */
export const CAPABILITIES = ["transport", "metronome", "speed", "loop", "tab"] as const;

/** One piece of a shared tab is this many bytes (about 11 K characters as base64, under a frame). */
export const TAB_CHUNK_BYTES = 8 * 1024;
/** A tab bigger than this (as a Guitar Pro file) is not sent. */
export const MAX_TAB_BYTES = 12 * 1024 * 1024;
/** How many pieces may be on the way before the receiver has said it got the first of them. */
export const TAB_WINDOW = 12;

/** Which score a peer has open. Two apps only start together on the same one. */
export interface ScoreFingerprint {
  /** SHA-256 of the file, or of the exported tab when it has unsaved edits. */
  key: string;
  bars: number;
  /**
   * Which tab of the host's this is (the host's tab id; a guest's copy of a host tab keeps it). It
   * tells two tabs of the same song apart. A tab the guest opened itself has none, and matches
   * any tab of the same song.
   */
  origin?: number;
}

export type TransportAction = "play" | "pause" | "stop" | "seek" | "settings";

/** What a guest may ask the host to do. The host decides and starts it for both. */
export type RequestAction = "play" | "pause" | "stop" | "seek";

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
      /** A guest moving the live connection to the tab it just received: welcome it again. */
      resume?: boolean;
      /**
       * A guest's own id, the same every time this app joins. The host recognises a guest that
       * comes back by it (and turns a banned one away). Never leaves the two apps.
       */
      guest?: string;
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
  /** A guest asks the host for Play, Pause, Stop or a new position (`tick`, when stopped). */
  | { type: "request"; action: RequestAction; tick?: number }
  | { type: "bye"; reason: string }
  // ----- sharing the tab (host to guest, as a Guitar Pro file in pieces) -----
  /** The host offers its tab. `sha` checks the file, `key` is the score fingerprint it matches. */
  | {
      type: "tab-offer";
      id: number;
      name: string;
      size: number;
      chunks: number;
      sha: string;
      key: string;
      bars: number;
      /** Which of the host's tabs this is (see `ScoreFingerprint.origin`). */
      origin?: number;
    }
  /** Piece `i` (from 0) of offer `id`, as base64. */
  | { type: "tab-chunk"; id: number; i: number; data: string }
  /** The guest has the first `n` pieces: the host may send more. */
  | { type: "tab-ack"; id: number; n: number }
  /** The guest has opened the whole tab (or could not). */
  | { type: "tab-done"; id: number; ok: boolean; reason?: string }
  /** Either side stops offer `id`. */
  | { type: "tab-abort"; id: number; reason: string };

export type RefuseReason = "version" | "score" | "declined" | "busy" | "full" | "banned";

/** What a host says in its goodbye when it removes a guest. */
export type DismissReason = "kicked" | "banned";

/** How many players a session holds, the host included. */
export const MAX_PLAYERS = 10;

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
const REQUEST_ACTIONS: readonly string[] = ["play", "pause", "stop", "seek"];

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
        (score.origin === undefined || isNumber(score.origin)) &&
        (m.session === undefined || isString(m.session)) &&
        (m.resume === undefined || typeof m.resume === "boolean") &&
        (m.guest === undefined || (isString(m.guest) && m.guest.length <= 64))
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
    case "request":
      return (
        isString(m.action) &&
        REQUEST_ACTIONS.includes(m.action) &&
        (m.tick === undefined || isNumber(m.tick))
      );
    case "bye":
      return isString(m.reason);
    case "tab-offer":
      return (
        isNumber(m.id) &&
        isString(m.name) &&
        isNumber(m.size) &&
        isNumber(m.chunks) &&
        isString(m.sha) &&
        isString(m.key) &&
        isNumber(m.bars) &&
        (m.origin === undefined || isNumber(m.origin))
      );
    case "tab-chunk":
      return isNumber(m.id) && isNumber(m.i) && isString(m.data);
    case "tab-ack":
      return isNumber(m.id) && isNumber(m.n);
    case "tab-done":
      return (
        isNumber(m.id) &&
        typeof m.ok === "boolean" &&
        (m.reason === undefined || isString(m.reason))
      );
    case "tab-abort":
      return isNumber(m.id) && isString(m.reason);
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

/**
 * The host's loop, kept inside this score: the host's bar numbers mean nothing to a guest whose
 * score has fewer bars (a bad or hostile message), so they are brought into range. No bars, no loop.
 */
export function clampLoop(
  loop: { from: number; to: number } | null,
  bars: number,
): { from: number; to: number } | null {
  if (!loop || bars < 1) return null;
  const last = bars - 1;
  const from = Math.min(Math.max(0, Math.trunc(loop.from)), last);
  const to = Math.min(Math.max(from, Math.trunc(loop.to)), last);
  return { from, to };
}
