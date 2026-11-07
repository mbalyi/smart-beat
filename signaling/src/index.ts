import { Room } from "./room";

export { Room };

/** The Workers rate limiting binding (see `wrangler.toml`), as far as this Worker uses it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Limits how fast one address makes rooms. Absent in tests and local runs. */
  CREATE_LIMIT?: RateLimiter;
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Room codes are 8 characters of this alphabet, shown as `ABCD-EFGH`. */
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function newCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % 32]).join("");
}

/** What a person typed, as a code: dashes, spaces and case do not matter. */
export function normalize(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

const room = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/rooms" && request.method === "POST") {
      // Every room is a Durable Object with an alarm, so making them is limited per address.
      if (env.CREATE_LIMIT) {
        const address = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.CREATE_LIMIT.limit({ key: address });
        if (!success) return json({ error: "rate-limited" }, 429);
      }
      for (let tries = 0; tries < 5; tries += 1) {
        const code = newCode();
        const answer = await room(env, code).fetch("https://room/create", { method: "POST" });
        if (answer.status === 409) continue;
        const { token } = (await answer.json()) as { token: string };
        return json({ code, token });
      }
      return json({ error: "busy" }, 503);
    }
    const match = /^\/v1\/rooms\/([^/]+)\/(join|send|poll|kick)$/.exec(url.pathname);
    if (!match) return json({ error: "not-found" }, 404);
    let typed: string;
    try {
      typed = decodeURIComponent(match[1]!);
    } catch {
      // A broken percent escape (`%E0`) is a bad code, not a crash.
      return json({ error: "bad-code" }, 400);
    }
    const code = normalize(typed);
    if (!CODE.test(code)) return json({ error: "bad-code" }, 400);
    const action = match[2]!;
    const expected = action === "poll" ? "GET" : "POST";
    if (request.method !== expected) return json({ error: "method" }, 405);
    const target = new URL(`https://room/${action}`);
    target.search = url.search;
    const headers = new Headers();
    const authorization = request.headers.get("authorization");
    if (authorization) headers.set("authorization", authorization);
    return room(env, code).fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.text() : undefined,
    });
  },
} satisfies ExportedHandler<Env>;
