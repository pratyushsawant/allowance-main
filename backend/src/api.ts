/**
 * HTTP API.
 *   POST /api/sessions          access code -> short-lived agent or operator session token
 *   Agent scope:    catalog, market search, buy, read purchases, budget, voice session
 *   Operator scope: approve, decline, freeze, unfreeze
 * An agent credential (static or session) can never approve, decline or unfreeze.
 * See docs/VOICE_INTEGRATION.md for how the frontend uses these.
 */
import { AssistantError, type Assistant } from "./assistant.ts";
import type { Auth } from "./auth.ts";
import { clientAddress, constantTimeEqual, createFailureLimiter, createRequestLimiter, type Window } from "./auth.ts";
import type { Buyer } from "./buyer.ts";
import { QuoteError } from "./buyer.ts";
import { CATALOG, getItem, SELLERS, TICKER_PATTERN, type SellerId } from "./catalog.ts";
import { HttpError, parseLimit, readJson, sendJson, type Router } from "./http.ts";
import { LedgerError, type Ledger, type Purchase } from "./ledger.ts";
import type { MarketData } from "./market-data.ts";
import type { PolicyConfig } from "./policy.ts";
import type { Scope, SessionSigner } from "./session.ts";
import { spokenSummary } from "./summary.ts";
import { formatBaseUnits } from "./units.ts";
import { VoiceNotConfiguredError, VoiceUpstreamError, type VoiceSessions } from "./voice.ts";

export interface ApiDeps {
  ledger: Ledger;
  buyer: Buyer;
  market: MarketData;
  policy: PolicyConfig;
  publicBaseUrl: string;
  auth: Auth;
  sessions: SessionSigner;
  /** Access codes a person types to get a session. Missing = that scope cannot log in. */
  accessCodes: Partial<Record<Scope, string>>;
  sessionTtlSeconds: Record<Scope, number>;
  voice: VoiceSessions;
  gatewayAvailable: () => Promise<bigint>;
  /** Payee address per seller, to tell the UI which sellers are on the allowlist (display only). */
  sellerAddresses?: Partial<Record<SellerId, string>>;
  /** Server-side Claude assistant (POST /api/chat). Absent in tests that don't need it. */
  assistant?: Assistant;
  /**
   * Request header a trusted proxy overwrites with the client's address (Railway: x-real-ip). Rate
   * limits are per client by this header; without it, by socket address.
   */
  clientIpHeader?: string;
  /** Overrides for DEFAULT_LIMITS (tests). */
  limits?: Partial<Limits>;
}

/**
 * Rate limits. Logins: failed attempts. Chat and voice: requests that cost money upstream (each chat
 * message is up to six model calls; each voice session is an ElevenLabs conversation). The totals
 * cap spending even when many clients share the public demo code.
 */
export type Limits = Record<"loginFailuresPerClient" | "loginFailuresTotal" | "chatPerClient" | "chatTotal" | "voicePerClient" | "voiceTotal", Window>;
const MINUTE = 60_000;
export const DEFAULT_LIMITS: Limits = {
  loginFailuresPerClient: { limit: 10, windowMs: 10 * MINUTE },
  loginFailuresTotal: { limit: 100, windowMs: 10 * MINUTE },
  chatPerClient: { limit: 60, windowMs: 10 * MINUTE },
  chatTotal: { limit: 300, windowMs: 60 * MINUTE },
  voicePerClient: { limit: 20, windowMs: 10 * MINUTE },
  voiceTotal: { limit: 100, windowMs: 60 * MINUTE },
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

const NEXT_STEP: Partial<Record<Purchase["state"], string>> = {
  awaiting_approval: "Tell the person the price and ask them to approve it in the app. When the app says it was approved, call get_purchase.",
  blocked: "Do not retry. Tell the person why it was blocked.",
  declined: "The person declined this purchase. Do not retry.",
  aborted: "The purchase did not go through and nothing was paid. Tell the person.",
  pending_unknown: "Payment is being confirmed. Call get_purchase again in a few seconds.",
  accepted: "Paid. Use `summary`, or `result` for details.",
  settled: "Paid and settled onchain. Use `summary`, or `result` for details.",
};

export function registerApi(router: Router, deps: ApiDeps): void {
  const { auth } = deps;
  const usdc = (v: bigint) => formatBaseUnits(v, deps.policy.decimals);
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const client = (req: Parameters<typeof clientAddress>[0]) => clientAddress(req, deps.clientIpHeader);
  const loginFailures = createFailureLimiter(limits.loginFailuresPerClient, limits.loginFailuresTotal);
  const chatRequests = createRequestLimiter(limits.chatPerClient, limits.chatTotal);
  const voiceRequests = createRequestLimiter(limits.voicePerClient, limits.voiceTotal);
  const RATE_LIMITED = "Too many requests right now. Wait a few minutes and try again.";

  const view = (p: Purchase) => ({
    id: p.id,
    item: p.itemId,
    seller: p.sellerId,
    state: p.state,
    priceUsdc: usdc(p.amount),
    amount: p.amount,
    reason: p.reason,
    next: NEXT_STEP[p.state] ?? null,
    summary: spokenSummary(p, deps.policy.timeZone),
    payTo: p.payTo,
    nonce: p.nonce,
    gatewayTransferId: p.gatewayTransferId,
    settlementTx: p.settlementTx,
    approvalExpiresAt: p.approvalExpiresAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    result: p.state === "accepted" || p.state === "settled" ? p.result : undefined,
  });

  const ledgerCall = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LedgerError) throw new HttpError(err.code === "not_found" ? 404 : 409, err.code, err.message);
      throw err;
    }
  };

  router.add("GET", "/health", ({ res }) => sendJson(res, 200, { ok: true }));

  router.add("POST", "/api/sessions", async ({ req, res }) => {
    const from = client(req);
    loginFailures.check(from);
    const body = await readJson(req);
    const scope = body.scope === "operator" ? "operator" : body.scope === "agent" ? "agent" : null;
    if (!scope) throw new HttpError(400, "invalid_scope", 'scope must be "agent" or "operator"');
    const expected = deps.accessCodes[scope];
    const given = typeof body.accessCode === "string" ? body.accessCode : "";
    if (!expected || !given || !constantTimeEqual(given, expected)) {
      loginFailures.fail(from);
      throw new HttpError(401, "invalid_access_code", "Wrong access code");
    }
    sendJson(res, 200, deps.sessions.issue(scope, deps.sessionTtlSeconds[scope]));
  });

  // ----- Assistant (agent scope: it can ask to buy, never approve) -----
  /** Chat turns call the model: refused before any work when the client or everyone is over the limit. */
  const chatAllowed = (req: Parameters<typeof clientAddress>[0], res: Parameters<typeof sendJson>[0]): boolean => {
    if (chatRequests.take(client(req))) return true;
    sendJson(res, 429, { error: "rate_limited", message: `${RATE_LIMITED} Nothing was bought.`, purchases: [] });
    return false;
  };
  const assistantCall = async (res: Parameters<typeof sendJson>[0], fn: () => Promise<unknown> | unknown) => {
    if (!deps.assistant) {
      return sendJson(res, 503, { error: "assistant_not_configured", message: "The AI assistant isn't available on this server. Nothing was bought.", purchases: [] });
    }
    try {
      sendJson(res, 200, await fn());
    } catch (err) {
      if (err instanceof AssistantError) return sendJson(res, err.status, { error: err.code, message: err.message, purchases: err.purchases });
      throw err;
    }
  };

  router.add("GET", "/api/assistant", ({ req, res }) => {
    auth.require(req, "agent");
    sendJson(res, 200, deps.assistant?.status() ?? { configured: false, model: null, problem: null });
  });

  router.add("POST", "/api/chat", async ({ req, res }) => {
    auth.require(req, "agent");
    const body = await readJson(req);
    if (!chatAllowed(req, res)) return;
    await assistantCall(res, () =>
      deps.assistant!.chat({ conversationId: String(body.conversationId ?? ""), messageId: String(body.messageId ?? ""), text: String(body.text ?? "") }),
    );
  });

  router.add("POST", "/api/chat/event", async ({ req, res }) => {
    auth.require(req, "agent");
    const body = await readJson(req);
    if (!chatAllowed(req, res)) return;
    await assistantCall(res, () =>
      deps.assistant!.purchaseUpdate({
        conversationId: String(body.conversationId ?? ""),
        messageId: String(body.messageId ?? ""),
        purchaseId: String(body.purchaseId ?? ""),
      }),
    );
  });

  router.add("GET", "/api/chat/:id", async ({ req, res, params }) => {
    auth.require(req, "agent");
    await assistantCall(res, () => ({ conversationId: params.id, messages: deps.assistant!.transcript(params.id) }));
  });

  router.add("POST", "/api/voice/session", async ({ req, res }) => {
    auth.require(req, "agent");
    const body = await readJson(req);
    if (!voiceRequests.take(client(req))) throw new HttpError(429, "rate_limited", RATE_LIMITED);
    const transport = body.transport === "websocket" ? "websocket" : "webrtc";
    try {
      sendJson(res, 200, await deps.voice.create(transport));
    } catch (err) {
      if (err instanceof VoiceNotConfiguredError) {
        return sendJson(res, 503, { error: "voice_not_configured", message: err.message, missing: err.missing });
      }
      if (err instanceof VoiceUpstreamError) throw new HttpError(502, "voice_upstream_error", err.message);
      throw err;
    }
  });

  // `sellerAllowlisted` is for display. Every purchase is still checked against the payee in the
  // seller's actual 402 offer, never against this listing.
  const allowlisted = (sellerId: SellerId): boolean | undefined => {
    const address = deps.sellerAddresses?.[sellerId];
    return address === undefined ? undefined : deps.policy.allowedPayees.some((p) => p.toLowerCase() === address.toLowerCase());
  };

  router.add("GET", "/api/catalog", ({ req, res }) => {
    auth.require(req, "agent");
    sendJson(res, 200, {
      items: CATALOG.map((i) => ({
        id: i.id, title: i.title, description: i.description, priceUsdc: i.priceUsdc,
        seller: i.sellerId, sellerName: SELLERS[i.sellerId].name, sellerAllowlisted: allowlisted(i.sellerId),
      })),
    });
  });

  router.add("GET", "/api/markets/search", ({ req, res, url }) => {
    auth.require(req, "agent");
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2 || q.length > 80) throw new HttpError(400, "invalid_query", "q must be 2 to 80 characters");
    sendJson(res, 200, { results: deps.market.search(q) });
  });

  router.add("POST", "/api/purchases", async ({ req, res }) => {
    auth.require(req, "agent");
    const body = await readJson(req);
    const item = typeof body.item === "string" ? getItem(body.item) : undefined;
    if (!item) throw new HttpError(400, "unknown_item", `item must be one of: ${CATALOG.map((i) => i.id).join(", ")}`);
    const ticker = typeof body.ticker === "string" ? body.ticker : "";
    if (!TICKER_PATTERN.test(ticker)) throw new HttpError(400, "invalid_ticker", "ticker is required");
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!IDEMPOTENCY_KEY.test(key)) throw new HttpError(400, "invalid_idempotency_key", "idempotencyKey: 8-128 chars of [A-Za-z0-9._:-]");
    if (!deps.market.event(ticker)) throw new HttpError(404, "unknown_event", "No recorded event with that ticker");
    try {
      const p = await ledgerCall(() =>
        deps.buyer.purchase({ idempotencyKey: key, itemId: item.id, sellerId: item.sellerId, resourceUrl: `${deps.publicBaseUrl}${item.path(ticker)}` }),
      );
      sendJson(res, 200, view(p));
    } catch (err) {
      if (err instanceof QuoteError) throw new HttpError(502, "seller_unavailable", err.message);
      throw err;
    }
  });

  router.add("GET", "/api/purchases", ({ req, res, url }) => {
    auth.require(req, "agent");
    const limit = parseLimit(url.searchParams.get("limit"), 20, 100);
    sendJson(res, 200, { purchases: deps.ledger.recent(limit).map(view) });
  });

  router.add("GET", "/api/purchases/:id", ({ req, res, params }) => {
    auth.require(req, "agent");
    const p = deps.ledger.get(params.id);
    if (!p) throw new HttpError(404, "not_found", "No such purchase");
    sendJson(res, 200, view(p));
  });

  router.add("GET", "/api/budget", async ({ req, res }) => {
    auth.require(req, "agent");
    const b = deps.ledger.budget(await deps.gatewayAvailable());
    sendJson(res, 200, {
      ...b,
      dailyCapUsdc: usdc(b.dailyCap),
      committedTodayUsdc: usdc(b.committedToday),
      remainingTodayUsdc: usdc(b.remainingToday),
      autoApproveMaxUsdc: usdc(b.autoApproveMax),
      perCallMaxUsdc: usdc(b.perCallMax),
      availableFundsUsdc: b.availableFunds === null ? null : usdc(b.availableFunds),
    });
  });

  router.add("POST", "/api/purchases/:id/approve", async ({ req, res, params }) => {
    auth.require(req, "operator");
    sendJson(res, 200, view(await ledgerCall(() => deps.buyer.approve(params.id))));
  });

  router.add("POST", "/api/purchases/:id/decline", async ({ req, res, params }) => {
    auth.require(req, "operator");
    sendJson(res, 200, view(await ledgerCall(() => deps.ledger.decline(params.id))));
  });

  router.add("POST", "/api/policy/freeze", async ({ req, res }) => {
    auth.require(req, "operator");
    const body = await readJson(req);
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "Frozen by the operator";
    deps.ledger.setFrozen(true, reason);
    sendJson(res, 200, { frozen: true, reason });
  });

  router.add("POST", "/api/policy/unfreeze", ({ req, res }) => {
    auth.require(req, "operator");
    deps.ledger.setFrozen(false, null);
    sendJson(res, 200, { frozen: false });
  });
}
