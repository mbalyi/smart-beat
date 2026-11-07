import { RoomState, TTL_MS, type Role } from "./rooms";

/** How long a poll waits for a message before it answers with none. */
export const POLL_MS = 20_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const token = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** The secret in an `Authorization: Bearer …` header, or "". */
const bearer = (request: Request): string => {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1]! : "";
};

const isRole = (value: unknown): value is Role => value === "host" || value === "guest";

/** A guest's own id: random hex made by the app. Anything else is ignored. */
const GUEST_ID = /^[0-9a-f]{8,64}$/;

/**
 * One room. State lives in memory: a room only matters while players connect (or come back),
 * and a Durable Object that restarts simply makes everyone start again.
 */
export class Room implements DurableObject {
  private readonly room = new RoomState();
  private waiters = new Set<() => void>();

  constructor(private readonly state: DurableObjectState) {}

  private wake() {
    for (const resolve of [...this.waiters]) resolve();
  }

  async alarm() {
    // The host's activity moves the expiry later: wait for the new time.
    const now = Date.now();
    if (this.room.alive && this.room.expiry > now) {
      await this.state.storage.setAlarm(this.room.expiry);
      return;
    }
    this.room.clear();
    this.wake();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    switch (url.pathname) {
      case "/create": {
        const mine = this.room.create(now, token());
        if (mine === null) return json({ error: "exists" }, 409);
        await this.state.storage.setAlarm(now + TTL_MS);
        return json({ token: mine });
      }
      case "/join": {
        const body = (await request.json().catch(() => null)) as { guest?: unknown } | null;
        const id = typeof body?.guest === "string" && GUEST_ID.test(body.guest) ? body.guest : null;
        const result = this.room.join(now, token(), id);
        if (result === "unknown") return json({ error: "unknown" }, 404);
        if (result === "full") return json({ error: "full" }, 409);
        if (result === "banned") return json({ error: "banned" }, 403);
        if (result === "rate-limited") return json({ error: "rate-limited" }, 429);
        this.wake();
        return json(result);
      }
      case "/kick": {
        const body = (await request.json().catch(() => null)) as {
          token?: unknown;
          peer?: unknown;
          ban?: unknown;
        } | null;
        if (!body || typeof body.token !== "string" || typeof body.peer !== "string") {
          return json({ error: "bad-request" }, 400);
        }
        const result = this.room.kick(body.token, body.peer, body.ban === true, now);
        if (result === "ok") {
          this.wake();
          return json({ ok: true });
        }
        return json({ error: result }, { denied: 403, gone: 404, unknown: 404 }[result]);
      }
      case "/send": {
        const body = (await request.json().catch(() => null)) as {
          role?: unknown;
          token?: unknown;
          msg?: unknown;
          to?: unknown;
        } | null;
        if (
          !body ||
          !isRole(body.role) ||
          typeof body.token !== "string" ||
          typeof body.msg !== "string"
        ) {
          return json({ error: "bad-request" }, 400);
        }
        const to = typeof body.to === "string" ? body.to : undefined;
        const result = this.room.send(body.role, body.token, body.msg, now, to);
        if (result === "ok") {
          this.wake();
          return json({ ok: true });
        }
        const status = { denied: 403, "too-big": 413, full: 429, gone: 404, "no-guest": 404 }[
          result
        ];
        return json({ error: result }, status);
      }
      case "/poll": {
        const role = url.searchParams.get("role");
        // The token travels in a header, not in the address: addresses end up in logs.
        const key = bearer(request);
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!isRole(role) || !Number.isFinite(after)) return json({ error: "bad-request" }, 400);
        const deadline = now + POLL_MS;
        for (;;) {
          const result = this.room.read(role, key, after, Date.now());
          if (result === "denied") return json({ error: "denied" }, 403);
          if (result === "gone") return json({ error: "gone" }, 404);
          if (result.messages.length > 0 || Date.now() >= deadline) {
            return json({ ...result, guest: this.room.hasGuest, guests: this.room.guestCount });
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.waiters.delete(done);
              resolve();
            };
            const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
            this.waiters.add(done);
          });
        }
      }
      default:
        return json({ error: "not-found" }, 404);
    }
  }
}
