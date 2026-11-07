import type { HostRoom } from "@/lib/practice-together/host-room";
import type { Session } from "@/lib/practice-together/session";

/**
 * Practice together across tabs: ONE live session (one connection, one clock) that moves between
 * the open tabs of the app. Each tab that took part is "included"; the tab that is shown (and plays)
 * owns the session. This module only keeps the book: which session, which tab owns it, which tabs
 * are in it, and what each tab's score is. The hooks do the work (see `use-practice-together.ts`).
 */

/** Where two players meet: on the same network, or over the internet. */
export type HostCodeInfo = { kind: "lan" | "internet"; code: string; address?: string };

/** A guest waiting for the host's yes. */
export interface WaitingGuest {
  name: string;
  resolve: (ok: boolean) => void;
}

/** What the old owner leaves for the next one when a session moves tab. */
export interface LiveCarry {
  hostCode: HostCodeInfo | null;
  approvals: WaitingGuest[];
}

/** The tab that shows and plays the session now. */
export interface LiveOwner {
  /** The workspace (tab) id. */
  readonly id: number;
  /** The host's tab stops everybody's playback before the session leaves it. */
  pause(): Promise<void>;
  /** Stops showing the session here without ending it; returns what the next owner needs. */
  release(): LiveCarry;
  /** The session ended (it was left from another tab): clear what this tab shows. */
  ended(): void;
}

export type LiveSession = Session | HostRoom;

interface LiveState {
  /** null while a guest's connection is on its way to a tab that is still opening. */
  session: LiveSession | null;
  owner: LiveOwner | null;
  role: "host" | "guest";
  included: Set<number>;
  /** The fingerprint key of the song in each open tab (only kept while a session is live). */
  keys: Map<number, string>;
  /** A tab the session should move to (a guest's host changed tab, or the owner tab closed). */
  wanted: number | null;
  /** The session is moving from one tab to another. */
  claiming: boolean;
  /** The host's code and queue while no tab owns the session. */
  carry: LiveCarry | null;
}

/** What a tab (or the app) can see of the live session. */
export interface LiveSnapshot {
  live: boolean;
  role: "host" | "guest" | null;
  ownerId: number | null;
  /** The tabs in the session, in the order they joined. */
  ids: readonly number[];
  wanted: number | null;
  claiming: boolean;
}

const NONE: LiveSnapshot = {
  live: false,
  role: null,
  ownerId: null,
  ids: [],
  wanted: null,
  claiming: false,
};

let state: LiveState | null = null;
let snapshot: LiveSnapshot = NONE;
const listeners = new Set<() => void>();
/** The app shows the tab with this id (set by App, used to bring a tab to the front). */
let shower: ((id: number) => void) | null = null;

function publish() {
  snapshot = state
    ? {
        live: state.session !== null || state.owner !== null,
        role: state.role,
        ownerId: state.owner?.id ?? null,
        ids: [...state.included],
        wanted: state.wanted,
        claiming: state.claiming,
      }
    : NONE;
  for (const listener of [...listeners]) listener();
}

export const subscribeLive = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const liveSnapshot = (): LiveSnapshot => snapshot;

/** The live session, if any (the book is kept by the hooks through the functions below). */
export const liveSession = (): LiveSession | null => state?.session ?? null;
export const liveOwner = (): LiveOwner | null => state?.owner ?? null;
export const liveIncludes = (id: number): boolean => state?.included.has(id) ?? false;
export const liveCarry = (): LiveCarry | null => state?.carry ?? null;

/** A session starts in a tab. Any session that was live before is not touched here (end it first). */
export function liveStart(session: LiveSession, owner: LiveOwner, key: string) {
  const keys = new Map(state?.keys ?? []);
  keys.set(owner.id, key);
  state = {
    session,
    owner,
    role: session.role,
    included: new Set([owner.id]),
    keys,
    wanted: null,
    claiming: false,
    carry: null,
  };
  publish();
}

/**
 * The connection of a guest moved to a tab it opened (a received tab): a new session object takes
 * over, and the tabs that were in the session stay in it. Starts afresh when nothing was live.
 */
export function liveResume(session: LiveSession, owner: LiveOwner, key: string) {
  if (!state) return liveStart(session, owner, key);
  state.session = session;
  state.owner = owner;
  state.role = session.role;
  state.included.add(owner.id);
  state.keys.set(owner.id, key);
  state.wanted = null;
  state.claiming = false;
  state.carry = null;
  publish();
}

/** A guest's session left its tab on its way to a tab that is still opening. */
export function liveSuspend(carry: LiveCarry | null = null) {
  if (!state) return;
  state.session = null;
  state.owner = null;
  state.carry = carry;
  publish();
}

/** A tab starts taking over the session. */
export function liveBeginClaim() {
  if (!state) return;
  state.claiming = true;
  publish();
}

/** A claim did not work out: the session stays where it was. */
export function liveAbortClaim() {
  if (!state) return;
  state.claiming = false;
  publish();
}

/** The tab `owner` shows and plays the session now (it takes part from here on). */
export function liveSetOwner(owner: LiveOwner, key: string, session?: LiveSession) {
  if (!state) return;
  if (session) state.session = session;
  state.owner = owner;
  state.included.add(owner.id);
  state.keys.set(owner.id, key);
  state.claiming = false;
  state.wanted = null;
  state.carry = null;
  publish();
}

/** The owner let go without a next owner yet (the session waits for a tab to take it). */
export function liveDisown(carry: LiveCarry) {
  if (!state) return;
  state.owner = null;
  state.carry = carry;
  publish();
}

/** The song in tab `id` has this fingerprint now (only while a session is live). */
export function liveSetKey(id: number, key: string) {
  if (!state) return;
  if (state.keys.get(id) === key) return;
  state.keys.set(id, key);
  publish();
}

/** The tab with this fingerprint key, if one is open (the first one, the shown one first). */
export function liveTabWithKey(key: string): number | null {
  if (!state) return null;
  const owner = state.owner?.id;
  if (owner !== undefined && state.keys.get(owner) === key) return owner;
  for (const [id, k] of state.keys) if (k === key) return id;
  return null;
}

/** A tab was closed. Returns another included tab the session can move to (when this one owned it). */
export function liveTabClosed(id: number): number | null {
  if (!state) return null;
  state.keys.delete(id);
  state.included.delete(id);
  if (state.wanted === id) state.wanted = null;
  const next = state.owner?.id === id ? ([...state.included].at(-1) ?? null) : null;
  publish();
  return next;
}

/** Asks for the session to move to tab `id` (it does when that tab's hook sees this). */
export function liveWant(id: number) {
  if (!state) return;
  state.wanted = id;
  publish();
  shower?.(id);
}

export function liveClearWanted(id: number) {
  if (state?.wanted !== id) return;
  state.wanted = null;
  publish();
}

/** App: how a tab is brought to the front. */
export function setLiveShower(fn: ((id: number) => void) | null) {
  shower = fn;
}

/** The session is over (left, ended by the host, removed): forget it. Tells the owner. */
export function liveEnd() {
  const old = state;
  state = null;
  publish();
  if (!old) return;
  old.owner?.ended();
  old.session?.leave();
}

/** Forgets the book without leaving the session (it was left already). */
export function liveForget() {
  const old = state;
  state = null;
  publish();
  old?.owner?.ended();
}

/** For tests: forget everything. */
export function resetLive() {
  state = null;
  snapshot = NONE;
  shower = null;
  listeners.clear();
}
