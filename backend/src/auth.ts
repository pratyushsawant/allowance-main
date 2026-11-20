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

/** Fixed-window limiter for failed logins: `limit` failures per `windowMs` per key. */
export function createFailureLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const buckets = new Map<string, { failures: number; resetAt: number }>();
  return {
    check(key: string): void {
      const b = buckets.get(key);
      if (b && b.resetAt > now() && b.failures >= limit) {
        throw new HttpError(429, "too_many_attempts", "Too many failed attempts; try again later");
      }
    },
    fail(key: string): void {
      const t = now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) buckets.set(key, { failures: 1, resetAt: t + windowMs });
      else b.failures++;
    },
  };
}
