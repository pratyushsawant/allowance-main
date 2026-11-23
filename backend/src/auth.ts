/**
 * Route authorization.
 *   agent scope:    static AGENT_API_TOKEN, an agent session, or anything operator-scoped
 *   operator scope: static OPERATOR_API_TOKEN or an operator session; nothing else
 * Sessions come from POST /api/sessions with the matching access code. Failed logins are
 * rate-limited per client address.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./http.ts";
import type { Scope, SessionSigner } from "./session.ts";

const digest = (s: string) => createHash("sha256").update(s).digest();
export const constantTimeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface AuthOptions {
  agentToken: string;
  operatorToken: string;
  sessions: SessionSigner;
}

export function createAuth(o: AuthOptions) {
  return {
    require(req: IncomingMessage, scope: Scope): void {
      const header = String(req.headers.authorization ?? "");
      const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (given) {
        if (constantTimeEqual(given, o.operatorToken)) return;
        if (scope === "agent" && constantTimeEqual(given, o.agentToken)) return;
        const claims = o.sessions.verify(given);
        if (claims && (claims.scope === "operator" || claims.scope === scope)) return;
      }
      throw new HttpError(401, "unauthorized", `This route needs ${scope} access`);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The client's address, for rate limiting. Behind a proxy that overwrites a header with the real
 * address on every request (Railway's edge sets X-Real-IP), pass that header's name; the last value
 * is the one the proxy wrote. Without it the socket address is used, so a client can't choose its
 * own key by sending the header. Behind a proxy, the socket address is the proxy's: every client
 * would share one key, and one client's failed logins would lock out everyone.
 */
export function clientAddress(req: IncomingMessage, trustedHeader?: string): string {
  if (trustedHeader) {
    const raw = req.headers[trustedHeader.toLowerCase()];
    const last = (Array.isArray(raw) ? raw.join(",") : raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 64);
  }
  return req.socket.remoteAddress ?? "unknown";
}

export type Window = { limit: number; windowMs: number };

/** Fixed-window counter: at most `limit` hits per `windowMs` per key. Expired keys are swept, so memory stays bounded. */
export function createWindowCounter({ limit, windowMs }: Window, now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const live = (key: string, t: number) => {
    const b = buckets.get(key);
    return b && b.resetAt > t ? b : undefined;
  };
  return {
    full(key: string): boolean {
      return (live(key, now())?.count ?? 0) >= limit;
    },
    add(key: string): void {
      const t = now();
      const b = live(key, t);
      if (b) b.count++;
      else {
        if (buckets.size >= 10_000) for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
        buckets.set(key, { count: 1, resetAt: t + windowMs });
      }
    },
  };
}

/** Failed logins: `perClient` failures per client, plus a `total` backstop across all clients. */
export function createFailureLimiter(perClient: Window, total: Window, now: () => number = Date.now) {
  const clients = createWindowCounter(perClient, now);
  const all = createWindowCounter(total, now);
  return {
    check(client: string): void {
      if (clients.full(client) || all.full("*")) {
        throw new HttpError(429, "too_many_attempts", "Too many failed attempts; try again later");
      }
    },
    fail(client: string): void {
      clients.add(client);
      all.add("*");
    },
  };
}

/** Requests to a costly endpoint: `perClient` per client and `total` across all clients. Counts the request when it is allowed. */
export function createRequestLimiter(perClient: Window, total: Window, now: () => number = Date.now) {
  const clients = createWindowCounter(perClient, now);
  const all = createWindowCounter(total, now);
  return {
    /** Returns false (and counts nothing) when the client or everyone together is over the limit. */
    take(client: string): boolean {
      if (clients.full(client) || all.full("*")) return false;
      clients.add(client);
      all.add("*");
      return true;
    },
  };
}
