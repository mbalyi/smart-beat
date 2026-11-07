import { Room } from "./room";

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace;
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
    const code = normalize(decodeURIComponent(match[1]!));
    if (!CODE.test(code)) return json({ error: "bad-code" }, 400);
    const action = match[2]!;
    const expected = action === "poll" ? "GET" : "POST";
    if (request.method !== expected) return json({ error: "method" }, 405);
    const target = new URL(`https://room/${action}`);
    target.search = url.search;
    return room(env, code).fetch(target, {
      method: request.method,
      body: request.method === "POST" ? await request.text() : undefined,
    });
  },
} satisfies ExportedHandler<Env>;
