// Low-level client for the Allowance backend (docs: FRONTEND_HANDOFF.md in the backend repo).
//
// Sessions: a person types an access code, the backend returns a short-lived token. Tokens live in
// memory only (never localStorage). The agent token is what tool handlers use; the operator token
// is requested only for Approve, Decline, Freeze and Unfreeze.

import { API_URL } from "./config";

export type Scope = "agent" | "operator";

export class ApiError extends Error {
  status: number;
  code: string;
  /** The full error body, e.g. `purchases` made before an assistant error. */
  body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** The person closed the access-code prompt. */
export class LoginCancelled extends Error {
  constructor() {
    super("Login cancelled");
  }
}

// ---------------------------------------------------------------------------
// Response shapes (subset of what the backend returns; see docs/api-examples)
// ---------------------------------------------------------------------------
export type PurchaseState =
  | "blocked" | "awaiting_approval" | "declined" | "approval_expired" | "reserved" | "aborted"
  | "signed" | "accepted" | "settled" | "rejected" | "pending_unknown" | "expired" | "needs_review";

export type Contract = {
  instrumentSymbol: string;
  label: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  lastTradePrice: string | null;
  observedAt: number | null;
};

export type EventSummary = {
  ticker: string;
  title: string;
  category: string | null;
  volume24h?: string | null;
  contracts: Contract[];
};

export type Purchase = {
  id: string;
  item: string;
  seller: string;
  state: PurchaseState;
  priceUsdc: string;
  reason: string | null;
  next: string | null;
  summary: string | null;
  gatewayTransferId: string | null;
  settlementTx: string | null;
  approvalExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
};

export type Budget = {
  day: string;
  timeZone: string;
  frozen: boolean;
  frozenReason: string | null;
  dailyCapUsdc: string;
  committedTodayUsdc: string;
  remainingTodayUsdc: string;
  autoApproveMaxUsdc: string;
  perCallMaxUsdc: string;
  availableFundsUsdc: string | null;
};

export type CatalogItem = {
  id: string;
  title: string;
  description: string;
  priceUsdc: string;
  seller: string;
  sellerName: string;
  /** Display only. The backend checks the payee of the seller's actual quote on every purchase. */
  sellerAllowlisted?: boolean;
};

/** GET /api/chain/movements (backend/src/streams.ts). `explorer` is only sent when the backend knows the explorer. */
export type ChainMovement = {
  canonicalId: string;
  block: number | null;
  txHash: string;
  logIndex: number | null;
  from: string;
  to: string;
  amountUsdc: string;
  classification: "top_up" | "gateway_deposit" | "gateway_withdrawal" | "unexpected_outbound" | "unrelated" | (string & {});
  observedAt: number;
  explorer?: string;
};

export type VoiceSession = { transport: "webrtc"; conversationToken: string; conversationId?: string };

/** A purchase the assistant made during a chat message. */
export type ChatPurchase = { purchaseId: string; item: string; ticker: string; title: string | null; state: PurchaseState; priceUsdc: string };

/** GET /api/chat/:id: what the person saw, to restore the chat after a refresh. */
export type TranscriptEntry = { id: string; from: "user" | "agent"; text: string; at: number; status?: ChatReply["status"] | "error" };

/** POST /api/chat and /api/chat/event. */
export type ChatReply = {
  conversationId: string;
  messageId: string;
  reply: string;
  status: "ok" | "approval_required" | "refused" | "incomplete";
  purchases: ChatPurchase[];
  replayed?: boolean;
  at: number;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
type Session = { token: string; expiresAt: number };
const sessions: Partial<Record<Scope, Session>> = {};
const EXPIRY_MARGIN_MS = 60_000;

type Prompt = (scope: Scope, error?: string) => Promise<string | null>;
let prompt: Prompt = async () => null;
/** The UI registers the access-code dialog here. */
export function setAccessCodePrompt(p: Prompt) {
  prompt = p;
}

const sessionListeners = new Set<(scope: Scope) => void>();
/** Called whenever a scope logs in. */
export function onLogin(fn: (scope: Scope) => void) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export const hasSession = (scope: Scope) => {
  const s = sessions[scope];
  return Boolean(s && s.expiresAt - EXPIRY_MARGIN_MS > Date.now());
};

/** Has anyone logged in on this page? Tells "session expired" apart from "never logged in". */
let everLoggedIn = false;
export const hasLoggedInBefore = () => everLoggedIn;

let pendingLogin: Partial<Record<Scope, Promise<string>>> = {};

/** A valid token for `scope`, asking the person for the access code if needed. */
export async function token(scope: Scope): Promise<string> {
  if (hasSession(scope)) return sessions[scope]!.token;
  pendingLogin[scope] ??= login(scope).finally(() => {
    pendingLogin = { ...pendingLogin, [scope]: undefined };
  });
  return pendingLogin[scope]!;
}

async function login(scope: Scope): Promise<string> {
  let error: string | undefined;
  for (;;) {
    const code = await prompt(scope, error);
    if (!code) throw new LoginCancelled();
    const r = await fetch(`${API_URL}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, accessCode: code }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      sessions[scope] = { token: body.token, expiresAt: body.expiresAt };
      everLoggedIn = true;
      sessionListeners.forEach((l) => l(scope));
      return body.token;
    }
    if (r.status === 429) error = "Too many wrong codes. Wait a few minutes, then try again.";
    else if (r.status === 401) error = "Wrong code. Try again.";
    else error = body.message ?? `Login failed (HTTP ${r.status})`;
  }
}

export function logout(scope: Scope) {
  delete sessions[scope];
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
/** The backend said our session is no longer valid while polling. Polls never pop up a login. */
export class SessionExpired extends Error {
  constructor() {
    super("Session expired");
  }
}

async function request<T>(scope: Scope, method: string, path: string, body?: unknown, signal?: AbortSignal, prompt = true): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!prompt && !hasSession(scope)) throw new SessionExpired();
    const t = await token(scope);
    const r = await fetch(`${API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const json = await r.json().catch(() => ({}));
    if (r.ok) return json as T;
    // Expired or revoked session. User actions log in again once and repeat the request (a chat
    // message keeps its messageId, so the backend never runs it twice). Polls stop and report it.
    if (r.status === 401) {
      logout(scope);
      if (!prompt) throw new SessionExpired();
      if (attempt === 0) continue;
    }
    throw new ApiError(r.status, json.error ?? "http_error", json.message ?? `HTTP ${r.status}`, json);
  }
}

/** Polling GETs: never prompt for a code; null until someone has logged in, SessionExpired if the backend rejects it. */
async function poll<T>(path: string): Promise<T | null> {
  if (!hasSession("agent") && !hasSession("operator")) return null;
  const scope: Scope = hasSession("agent") ? "agent" : "operator";
  return request<T>(scope, "GET", path, undefined, undefined, false);
}

export const backend = {
  catalog: () => request<{ items: CatalogItem[] }>("agent", "GET", "/api/catalog").then((r) => r.items),
  searchMarkets: (q: string) =>
    request<{ results: EventSummary[] }>("agent", "GET", `/api/markets/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
  // No `buy` here on purpose: the browser never calls POST /api/purchases. Purchases happen only in
  // the server-side assistant, behind its purchase gate and the backend's spending policy.
  purchase: (id: string) => request<Purchase>("agent", "GET", `/api/purchases/${encodeURIComponent(id)}`),
  budget: () => request<Budget>("agent", "GET", "/api/budget"),
  voiceSession: () => request<VoiceSession>("agent", "POST", "/api/voice/session", {}),

  // Assistant (server-side Claude). One messageId per message; resending the same id never re-runs it.
  chat: (conversationId: string, messageId: string, text: string, signal?: AbortSignal) =>
    request<ChatReply>("agent", "POST", "/api/chat", { conversationId, messageId, text }, signal),
  chatEvent: (conversationId: string, messageId: string, purchaseId: string) =>
    request<ChatReply>("agent", "POST", "/api/chat/event", { conversationId, messageId, purchaseId }),
  transcript: (conversationId: string) =>
    request<{ conversationId: string; messages: TranscriptEntry[] }>("agent", "GET", `/api/chat/${encodeURIComponent(conversationId)}`).then((r) => r.messages),
  assistantStatus: () => request<{ configured: boolean; model: string | null; problem: string | null }>("agent", "GET", "/api/assistant"),

  // Operator only.
  approve: (id: string) => request<Purchase>("operator", "POST", `/api/purchases/${encodeURIComponent(id)}/approve`),
  decline: (id: string) => request<Purchase>("operator", "POST", `/api/purchases/${encodeURIComponent(id)}/decline`),
  freeze: (reason: string) => request<{ frozen: true }>("operator", "POST", "/api/policy/freeze", { reason }),
  unfreeze: () => request<{ frozen: false }>("operator", "POST", "/api/policy/unfreeze"),

  // Polls (no prompt).
  pollPurchases: (limit = 20) => poll<{ purchases: Purchase[] }>(`/api/purchases?limit=${limit}`).then((r) => r?.purchases ?? null),
  pollBudget: () => poll<Budget>("/api/budget"),
  pollMovements: (limit = 20) => poll<{ movements: ChainMovement[] }>(`/api/chain/movements?limit=${limit}`).then((r) => r?.movements ?? null),
  pollCatalog: () => poll<{ items: CatalogItem[] }>("/api/catalog").then((r) => r?.items ?? null),
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
/** Midpoint of bid/ask (or last trade) as a 0–1 number, or null. */
export function midOf(c: Contract): number | null {
  const b = c.bestBid === null ? NaN : Number(c.bestBid);
  const a = c.bestAsk === null ? NaN : Number(c.bestAsk);
  if (Number.isFinite(b) && Number.isFinite(a)) return (b + a) / 2;
  if (Number.isFinite(b)) return b;
  if (Number.isFinite(a)) return a;
  const l = c.lastTradePrice === null ? NaN : Number(c.lastTradePrice);
  return Number.isFinite(l) ? l : null;
}

/**
 * A probability as a percentage with at most one decimal, formatted on its own and never adjusted
 * to make a set add up to 100% (same rule as the backend). For a total, show the backend's
 * `probabilitiesSum`; never add these strings.
 */
export function formatPct(p: number): string {
  const tenths = Math.round(p * 1000 + 1e-9);
  return tenths % 10 === 0 ? `${tenths / 10}%` : `${(tenths / 10).toFixed(1)}%`;
}
