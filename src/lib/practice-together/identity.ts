/**
 * What this app remembers about Practice together between runs, in this computer's own storage
 * only (never sent anywhere, never in the usage counters):
 *
 * - its own guest id: random, the same every time. A host knows a returning guest by it, and can
 *   ban it. Clearing the app's data makes a new one.
 * - the last session it joined: how to get back in when something went wrong (a dropped
 *   connection, a laptop that ran out of battery). It expires, and is forgotten when the host
 *   ended the session or banned the guest.
 */
import type { Connection } from "@/lib/practice-together/analytics";

const ID_KEY = "smart-beat:practice-together:guest";
const LAST_KEY = "smart-beat:practice-together:last";

/** A remembered session is offered again for this long. */
export const LAST_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

let memory: string | null = null;

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This app's own guest id (16 hex characters). */
export function guestId(): string {
  if (memory) return memory;
  try {
    const stored = localStorage.getItem(ID_KEY);
    if (stored && /^[0-9a-f]{16}$/.test(stored)) return (memory = stored);
  } catch {
    // Storage is blocked: the id lasts until the app closes.
  }
  memory = randomHex(8);
  try {
    localStorage.setItem(ID_KEY, memory);
  } catch {
    // Not remembered.
  }
  return memory;
}

export interface LastSession {
  kind: Connection;
  code: string;
  /** The host's name, once the guest has been let in. */
  host?: string;
  /** When it was joined (milliseconds since 1970). */
  at: number;
}

/** The session this app last joined, when it is recent enough to be worth offering. */
export function readLastSession(now = Date.now()): LastSession | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(LAST_KEY) ?? "null",
    ) as Partial<LastSession> | null;
    if (
      !value ||
      (value.kind !== "lan" && value.kind !== "internet") ||
      typeof value.code !== "string" ||
      typeof value.at !== "number" ||
      now - value.at > LAST_SESSION_TTL_MS ||
      now < value.at
    ) {
      return null;
    }
    return {
      kind: value.kind,
      code: value.code,
      at: value.at,
      ...(typeof value.host === "string" && { host: value.host }),
    };
  } catch {
    return null;
  }
}

export function rememberSession(session: LastSession) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(session));
  } catch {
    // Not remembered.
  }
}

/** The session ended for good: do not offer it again. */
export function forgetSession() {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {
    // Nothing to forget.
  }
}
