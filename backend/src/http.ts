/** Minimal JSON HTTP helpers on node:http (no framework). Authorization lives in auth.ts. */
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body, replacer));
}

export async function readJson(req: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "body_too_large", `Body over ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}

export function createRouter(log: (line: string) => void = console.error) {
  const routes: Array<{ method: string; parts: string[]; handler: Handler }> = [];
  return {
    add(method: string, pattern: string, handler: Handler): void {
      routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      try {
        for (const r of routes) {
          if (r.method !== req.method || r.parts.length !== parts.length) continue;
          const params: Record<string, string> = {};
          const match = r.parts.every((p, i) => {
            if (p.startsWith(":")) {
              params[p.slice(1)] = decodeURIComponent(parts[i]);
              return true;
            }
            return p === parts[i];
          });
          if (match) return await r.handler({ req, res, url, params });
        }
        throw new HttpError(404, "not_found", "No such route");
      } catch (err) {
        if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message });
        log(`[http] ${req.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
        return sendJson(res, 500, { error: "internal_error", message: "Unexpected server error" });
      }
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
