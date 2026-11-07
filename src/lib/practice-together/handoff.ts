import type { QualityChoice } from "@/lib/practice-together/quality-presets";
import type { PeerTransport } from "@/lib/practice-together/transport";

/**
 * A guest that received the host's tab opens it in a new tab of the app, and the live connection
 * moves there with it. The tab that received it leaves the connection here; the new tab's
 * workspace takes it as soon as it is on screen (the key tells which tab it is for).
 */
export interface Handoff {
  transport: PeerTransport;
  /** The session the guest was welcomed to, for the host to know it is the same guest. */
  session: string | null;
  peerName: string | null;
  /** The score fingerprint of the tab it is for. */
  key: string;
  quality: QualityChoice;
}

/** A handoff nobody takes within this time is dropped (and its connection closed). */
export const HANDOFF_TTL_MS = 15_000;

let pending: { handoff: Handoff; timer: ReturnType<typeof setTimeout> } | null = null;

/** Leaves the connection for the next workspace that shows the tab with `handoff.key`. */
export function putHandoff(handoff: Handoff) {
  clearHandoff();
  const timer = setTimeout(() => {
    if (pending?.handoff === handoff) {
      pending = null;
      handoff.transport.close();
    }
  }, HANDOFF_TTL_MS);
  pending = { handoff, timer };
}

/** Takes the connection left for the tab with `key`, once. */
export function takeHandoff(key: string): Handoff | null {
  if (!pending || pending.handoff.key !== key) return null;
  const { handoff, timer } = pending;
  clearTimeout(timer);
  pending = null;
  return handoff;
}

/** Forgets a pending handoff without closing its connection. */
export function clearHandoff() {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}
