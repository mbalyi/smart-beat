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

const isRole = (value: unknown): value is Role => value === "host" || value === "guest";

/**
 * One room. State lives in memory: a room only matters for the minute it takes two apps to
 * connect, and a Durable Object that restarts simply makes the pair start again.
 */
export class Room implements DurableObject {
  private readonly room = new RoomState();
  private waiters = new Set<() => void>();

  constructor(private readonly state: DurableObjectState) {}

  private wake() {
    for (const resolve of [...this.waiters]) resolve();
  }

  async alarm() {
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
        const result = this.room.join(now, token());
        if (result === "unknown") return json({ error: "unknown" }, 404);
        if (result === "full") return json({ error: "full" }, 409);
        this.wake();
        return json({ token: result });
      }
      case "/send": {
        const body = (await request.json().catch(() => null)) as {
          role?: unknown;
          token?: unknown;
          msg?: unknown;
        } | null;
        if (
          !body ||
          !isRole(body.role) ||
          typeof body.token !== "string" ||
          typeof body.msg !== "string"
        ) {
          return json({ error: "bad-request" }, 400);
        }
        const result = this.room.send(body.role, body.token, body.msg, now);
        if (result === "ok") {
          this.wake();
          return json({ ok: true });
        }
        const status = { denied: 403, "too-big": 413, full: 429, gone: 404 }[result];
        return json({ error: result }, status);
      }
      case "/poll": {
        const role = url.searchParams.get("role");
        const key = url.searchParams.get("token") ?? "";
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!isRole(role) || !Number.isFinite(after)) return json({ error: "bad-request" }, 400);
        const deadline = now + POLL_MS;
        for (;;) {
          const result = this.room.read(role, key, after, Date.now());
          if (result === "denied") return json({ error: "denied" }, 403);
          if (result === "gone") return json({ error: "gone" }, 404);
          if (result.messages.length > 0 || Date.now() >= deadline) {
            return json({ ...result, guest: this.room.hasGuest });
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
