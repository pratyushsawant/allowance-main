/**
 * CORS for the browser frontend: exact-origin allowlist, bearer tokens (no cookies, so no
 * Allow-Credentials), applied to /api/* and /health only. The /sellers/* routes are called
 * server-to-server by the buyer and get no CORS headers.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export function parseOrigins(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`CORS_ALLOWED_ORIGINS: "${origin}" is not a URL`);
      }
      if (parsed.origin !== origin) throw new Error(`CORS_ALLOWED_ORIGINS: use the bare origin "${parsed.origin}", not "${origin}"`);
      return origin;
    });
}

/** Returns true when it fully answered the request (a preflight). */
export function createCors(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? "/").split("?")[0];
    if (!path.startsWith("/api/") && path !== "/health") return false;
    const origin = req.headers.origin;
    if (typeof origin !== "string") return false; // not a browser cross-origin request
    const ok = allowed.has(origin);
    if (ok) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method !== "OPTIONS") return false;
    if (!ok) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "origin_not_allowed" }));
      return true;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "600",
    }).end();
    return true;
  };
}
