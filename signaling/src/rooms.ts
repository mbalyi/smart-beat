/**
 * The state of one Practice together room: two mailboxes and two secret tokens.
 *
 * A room only relays short setup messages (WebRTC offers, answers and network candidates)
 * between the host and one guest. It never sees the music, the tab or the playback commands:
 * those go straight between the two apps once they are connected.
 */

export type Role = "host" | "guest";

/** The longest setup message accepted, in characters. */
export const MAX_MESSAGE = 8 * 1024;
/** Setup messages a room accepts in total (an offer, an answer and a few dozen candidates). */
export const MAX_MESSAGES = 200;
/** A room is deleted this long after it was made. */
export const TTL_MS = 10 * 60 * 1000;

export type SendResult = "ok" | "denied" | "too-big" | "full" | "gone";

export class RoomState {
  private exists = false;
  private hostToken = "";
  private guestToken: string | null = null;
  private expires = 0;
  /** Messages waiting for each role, in order. Indexes only grow. */
  private boxes: Record<Role, string[]> = { host: [], guest: [] };

  get alive(): boolean {
    return this.exists;
  }

  /** Makes the room. Returns the host's token, or null when the room is already taken. */
  create(now: number, token: string): string | null {
    if (this.exists && now < this.expires) return null;
    this.exists = true;
    this.hostToken = token;
    this.guestToken = null;
    this.boxes = { host: [], guest: [] };
    this.expires = now + TTL_MS;
    return token;
  }

  /** Lets one guest in. Returns the guest's token, or why not. */
  join(now: number, token: string): string | "unknown" | "full" {
    if (!this.live(now)) return "unknown";
    if (this.guestToken !== null) return "full";
    this.guestToken = token;
    return token;
  }

  private live(now: number): boolean {
    if (this.exists && now >= this.expires) this.clear();
    return this.exists;
  }

  clear() {
    this.exists = false;
    this.hostToken = "";
    this.guestToken = null;
    this.boxes = { host: [], guest: [] };
  }

  private who(role: Role, token: string): boolean {
    const expected = role === "host" ? this.hostToken : this.guestToken;
    if (expected === null || expected.length !== token.length) return false;
    let diff = 0;
    for (let i = 0; i < token.length; i += 1) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  }

  /** Puts `message` in the other side's mailbox. */
  send(role: Role, token: string, message: string, now: number): SendResult {
    if (!this.live(now)) return "gone";
    if (!this.who(role, token)) return "denied";
    if (message.length > MAX_MESSAGE) return "too-big";
    const to: Role = role === "host" ? "guest" : "host";
    if (this.boxes.host.length + this.boxes.guest.length >= MAX_MESSAGES) return "full";
    this.boxes[to].push(message);
    return "ok";
  }

  /** The messages for `role` from index `after` on. */
  read(
    role: Role,
    token: string,
    after: number,
    now: number,
  ): { messages: string[]; next: number } | "denied" | "gone" {
    if (!this.live(now)) return "gone";
    if (!this.who(role, token)) return "denied";
    const from = Math.max(0, Math.floor(after));
    const box = this.boxes[role];
    return { messages: box.slice(from), next: Math.max(box.length, from) };
  }

  /** Whether the guest has joined (the host polls for this through the first message). */
  get hasGuest(): boolean {
    return this.guestToken !== null;
  }
}
