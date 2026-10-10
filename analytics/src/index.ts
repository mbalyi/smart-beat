// The Workers runtime only accepts handlers as exports of the entry module: everything else
// (validation, limits, SQL) lives in logic.ts.
import { cleanup, json, receive, summary, type Env } from "./logic";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/batch") {
      return request.method === "POST" ? receive(request, env) : json({ error: "Use POST." }, 405);
    }
    if (pathname === "/v1/summary") {
      return request.method === "GET" ? summary(request, env) : json({ error: "Use GET." }, 405);
    }
    return json({ error: "Not found." }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
