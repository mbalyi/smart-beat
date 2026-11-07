/**
 * The state of one Practice together room: a mailbox for the host, one for each guest, and
 * their secret tokens.
 *
 * A room only relays short setup messages (WebRTC offers, answers and network candidates)
 * between the host and its guests. It never sees the music, the tab or the playback commands:
 * those go straight between the apps once they are connected.
 *
 * A room holds up to {@link MAX_GUESTS} guests (ten players with the host). A guest that comes
 * back after something went wrong presents the same guest id and takes its old place. The host
 * can remove a guest, and ban its id.
 */

export type Role = "host" | "guest";

/** The longest setup message accepted, in characters. */
export const MAX_MESSAGE = 8 * 1024;
/** Setup messages the host's mailbox accepts in total. */
export const MAX_HOST_MESSAGES = 1500;
/** Setup messages one guest's mailbox accepts in total. */
export const MAX_GUEST_MESSAGES = 200;
/** A room is deleted when its host has been silent this long. */
export const TTL_MS = 10 * 60 * 1000;
/** A room is deleted this long after it was made, even if the host is still there. */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Guests a room takes: with the host, ten players. */
export const MAX_GUESTS = 9;

export type SendResult = "ok" | "denied" | "too-big" | "full" | "gone" | "no-guest";

/** What the host hears: who it is from and the message. */
export interface HostMail {
  from: string;
  msg: string;
}

interface Guest {
  peer: string;
  token: string;
  /** The guest's own stable id (the same app joins again with it), when it said one. */
  id: string | null;
  box: string[];
}

/** What a guest tells the host's page when it arrives: the host then starts the connection. */
export const JOINED = JSON.stringify({ k: "joined" });

function same(expected: string, token: string): boolean {
  if (expected.length === 0 || expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export class RoomState {
  private exists = false;
  private hostToken = "";
  private created = 0;
  private expires = 0;
  private guests = new Map<string, Guest>();
  private banned = new Set<string>();
  private hostBox: HostMail[] = [];
  private peers = 0;

  get alive(): boolean {
    return this.exists;
  }

  /** When the room goes if nothing happens (milliseconds on the caller's clock). */
  get expiry(): number {
    return this.expires;
  }

  /** Makes the room. Returns the host's token, or null when the room is already taken. */
  create(now: number, token: string): string | null {
    if (this.exists && now < this.expires) return null;
    this.exists = true;
    this.hostToken = token;
    this.created = now;
    this.guests = new Map();
    this.banned = new Set();
    this.hostBox = [];
    this.peers = 0;
    this.expires = now + TTL_MS;
    return token;
  }

  /** The host is there: the room lives on (up to its longest age). */
  private touch(now: number) {
    this.expires = Math.min(now + TTL_MS, this.created + MAX_AGE_MS);
  }

  /**
   * Lets a guest in. Returns the guest's token and its address in the room, or why not. A guest
   * id that is already in the room takes its old place back (its old token stops working).
   */
  join(
    now: number,
    token: string,
    id: string | null = null,
  ): { token: string; peer: string } | "unknown" | "full" | "banned" {
    if (!this.live(now)) return "unknown";
    if (id !== null && this.banned.has(id)) return "banned";
    if (id !== null) {
      for (const [peer, guest] of this.guests) {
        if (guest.id === id) this.guests.delete(peer);
      }
    }
    if (this.guests.size >= MAX_GUESTS) return "full";
    this.peers += 1;
    const peer = `g${this.peers}`;
    this.guests.set(peer, { peer, token, id, box: [] });
    this.hostBox.push({ from: peer, msg: JOINED });
    return { token, peer };
  }

  private live(now: number): boolean {
    if (this.exists && now >= this.expires) this.clear();
    return this.exists;
  }

  clear() {
    this.exists = false;
    this.hostToken = "";
    this.guests = new Map();
    this.banned = new Set();
    this.hostBox = [];
  }

  /** The guest that holds `token`, if any. */
  private guestOf(token: string): Guest | null {
    let found: Guest | null = null;
    // Every token is compared, so the time does not tell which one matched.
    for (const guest of this.guests.values()) if (same(guest.token, token)) found = guest;
    return found;
  }

  /**
   * Puts `message` in the other side's mailbox. A guest's goes to the host; the host names the
   * guest (`to`), or leaves it out when there is only one.
   */
  send(role: Role, token: string, message: string, now: number, to?: string): SendResult {
    if (!this.live(now)) return "gone";
    if (role === "host") {
      if (!same(this.hostToken, token)) return "denied";
      this.touch(now);
      if (message.length > MAX_MESSAGE) return "too-big";
      const guest =
        to !== undefined ? this.guests.get(to) : this.guests.size === 1 ? first(this.guests) : null;
      if (!guest) return "no-guest";
      if (guest.box.length >= MAX_GUEST_MESSAGES) return "full";
      guest.box.push(message);
      return "ok";
    }
    const guest = this.guestOf(token);
    if (!guest) return "denied";
    if (message.length > MAX_MESSAGE) return "too-big";
    if (this.hostBox.length >= MAX_HOST_MESSAGES) return "full";
    this.hostBox.push({ from: guest.peer, msg: message });
    return "ok";
  }

  /** The messages for `role` from index `after` on, with who each one is from. */
  read(
    role: Role,
    token: string,
    after: number,
    now: number,
  ): { messages: string[]; from: string[]; next: number } | "denied" | "gone" {
    if (!this.live(now)) return "gone";
    const from = Math.max(0, Math.floor(after));
    if (role === "host") {
      if (!same(this.hostToken, token)) return "denied";
      this.touch(now);
      const mail = this.hostBox.slice(from);
      return {
        messages: mail.map((m) => m.msg),
        from: mail.map((m) => m.from),
        next: Math.max(this.hostBox.length, from),
      };
    }
    const guest = this.guestOf(token);
    if (!guest) return "denied";
    const mail = guest.box.slice(from);
    return {
      messages: mail,
      from: mail.map(() => "host"),
      next: Math.max(guest.box.length, from),
    };
  }

  /**
   * The host removes a guest from the room. With `ban`, its id can never join this room again.
   * Returns "unknown" when there is no such guest.
   */
  kick(
    token: string,
    peer: string,
    ban: boolean,
    now: number,
  ): "ok" | "denied" | "gone" | "unknown" {
    if (!this.live(now)) return "gone";
    if (!same(this.hostToken, token)) return "denied";
    this.touch(now);
    const guest = this.guests.get(peer);
    if (!guest) return "unknown";
    if (ban && guest.id !== null) this.banned.add(guest.id);
    this.guests.delete(peer);
    return "ok";
  }

  /** How many guests the room has. */
  get guestCount(): number {
    return this.guests.size;
  }

  /** Whether any guest has joined (the host polls for this through the first message). */
  get hasGuest(): boolean {
    return this.guests.size > 0;
  }
}

function first(guests: Map<string, Guest>): Guest | null {
  for (const guest of guests.values()) return guest;
  return null;
}
