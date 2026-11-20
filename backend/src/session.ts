/**
 * Short-lived, scoped session tokens so a browser frontend never holds the static API tokens.
 *   as1.<base64url(claims)>.<base64url(HMAC-SHA256(secret, "allowance-session.v1." + claims))>
 * Stateless. Rotating SESSION_SECRET revokes every session.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type Scope = "agent" | "operator";

export interface SessionClaims {
  v: 1;
  scope: Scope;
  sid: string;
  iat: number;
  exp: number;
}

export function createSessionSigner(secret: string, now: () => number = Date.now) {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const mac = (payload: string) => createHmac("sha256", secret).update(`allowance-session.v1.${payload}`).digest();

  return {
    issue(scope: Scope, ttlSeconds: number): { token: string; scope: Scope; expiresAt: number } {
      const iat = Math.floor(now() / 1000);
      const claims: SessionClaims = { v: 1, scope, sid: randomUUID(), iat, exp: iat + ttlSeconds };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return { token: `as1.${payload}.${mac(payload).toString("base64url")}`, scope, expiresAt: claims.exp * 1000 };
    },

    /** Returns the claims of a valid, unexpired token, or null. Never throws on bad input. */
    verify(token: string): SessionClaims | null {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "as1") return null;
      const [, payload, signature] = parts;
      const given = Buffer.from(signature, "base64url");
      const expected = mac(payload);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let claims: Partial<SessionClaims>;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (claims.v !== 1 || (claims.scope !== "agent" && claims.scope !== "operator")) return null;
      if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return null;
      return claims as SessionClaims;
    },
  };
}

export type SessionSigner = ReturnType<typeof createSessionSigner>;
