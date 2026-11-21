// The Allowance backend behind the UI's Api interface.
//
// Chat goes to the server-side assistant (POST /api/chat): Claude with tools, where the backend
// decides whether a purchase may happen. Nothing in the browser decides to buy, and the browser has
// no way to call POST /api/purchases itself.
// Payments, budget and the onchain feed are polled (rates from FRONTEND_HANDOFF §5) and turned into
// the same ServerEvents the mock emits. Spending rules are server config: shown, never edited.
import {
  ApiError,
  backend,
  hasLoggedInBefore,
  hasSession,
  LoginCancelled,
  midOf,
  onLogin,
  SessionExpired,
  token,
  type Budget as BackendBudget,
  type CatalogItem,
  type ChainMovement,
  type ChatReply,
  type Contract,
  type Purchase,
  type TranscriptEntry,
} from "./backend";
import type { Api, Listener } from "./api";
import { EXPLORER_TX_URL } from "./config";
import type { AgentReply, Budget, ChatMessage, ChatStatus, Connection, MarketData, Movement, Payment, PaymentStatus, Rules, ServerEvent } from "./types";
import { voice } from "./voice";
import type { VoiceReply } from "./voiceTurns";

const listeners = new Set<Listener>();
export const emit = (e: ServerEvent) => listeners.forEach((l) => l(e));
/** An app notice in the chat (not written by the AI). */
const notice = (text: string, tone: "info" | "warn" = "info") => emit({ type: "notice", text, tone });

// ---------------------------------------------------------------------------
// Catalog cache and labels
// ---------------------------------------------------------------------------
let catalog: CatalogItem[] = [];
export async function getCatalog(): Promise<CatalogItem[]> {
  if (!catalog.length) catalog = await backend.catalog();
  return catalog;
}
const sellerName = (id: string) => catalog.find((i) => i.seller === id)?.sellerName ?? id;
const itemTitle = (id: string) => catalog.find((i) => i.id === id)?.title ?? id;

/** What a purchase is for, remembered when the assistant reports it (the purchase view has no event title). */
const descriptions = new Map<string, string>();
const describePurchase = (id: string, text: string) => descriptions.set(id, text);

// ---------------------------------------------------------------------------
// Mapping backend purchases into UI shapes (states: backend/src/ledger.ts)
// ---------------------------------------------------------------------------
const STATUS: Record<string, PaymentStatus> = {
  awaiting_approval: "awaiting",
  reserved: "pending",
  signed: "pending",
  pending_unknown: "pending",
  accepted: "confirmed",
  settled: "confirmed",
  needs_review: "review",
  // Nothing was paid for any of these.
  blocked: "not_charged",
  declined: "not_charged",
  approval_expired: "not_charged",
  aborted: "not_charged",
  rejected: "not_charged",
  expired: "not_charged",
};
const IN_FLIGHT = new Set(["reserved", "signed", "pending_unknown"]);

function leading(contracts: Array<{ label: string | null; mid: number | null }>): { label: string | null; mid: number } | null {
  let best: { label: string | null; mid: number } | null = null;
  for (const c of contracts) if (c.mid !== null && (!best || c.mid > best.mid)) best = { label: c.label, mid: c.mid };
  return best;
}

type Point = { bestBid: string | null; bestAsk: string | null; lastTradePrice: string | null };
function marketDataOf(p: Purchase): MarketData | undefined {
  const r = p.result as Record<string, unknown> | null | undefined;
  if (!r) return undefined;
  if (p.item === "odds_snapshot" || p.item === "deep_brief") {
    const ev = r.event as { title?: string; contracts?: Contract[] } | null | undefined;
    if (!ev?.contracts) return undefined;
    const top = leading(ev.contracts.map((c) => ({ label: c.label, mid: midOf(c) })));
    return top && ev.title ? { market: ev.title, yesPrice: top.mid, yesLabel: top.label ?? undefined } : undefined;
  }
  if (p.item === "odds_history") {
    const contracts = (r.contracts as Array<{ label: string | null; points?: Point[] }> | undefined) ?? [];
    const top = leading(
      contracts.map((c) => {
        const last = c.points?.at(-1);
        return { label: c.label, mid: last ? midOf({ ...last, instrumentSymbol: "", label: c.label, observedAt: null }) : null };
      }),
    );
    return top && typeof r.title === "string" ? { market: r.title, yesPrice: top.mid, yesLabel: top.label ?? undefined } : undefined;
  }
  return undefined;
}

function toPayment(p: Purchase): Payment {
  return {
    id: p.id,
    seller: sellerName(p.seller),
    amount: Number(p.priceUsdc),
    amountLabel: p.priceUsdc,
    txHash: p.settlementTx ?? "",
    status: STATUS[p.state] ?? "pending",
    timestamp: p.createdAt,
    data: marketDataOf(p),
    item: p.item,
    itemTitle: descriptions.get(p.id) ?? itemTitle(p.item),
    summary: p.summary,
    state: p.state,
    reason: p.reason,
  };
}

function toRules(b: BackendBudget): Rules {
  const allowed = [...new Set(catalog.filter((i) => i.sellerAllowlisted).map((i) => i.sellerName))];
  return {
    allowlist: allowed,
    perRequestCap: Number(b.perCallMaxUsdc),
    dailyBudget: Number(b.dailyCapUsdc),
    approvalThreshold: Number(b.autoApproveMaxUsdc),
    editable: false,
    frozen: b.frozen,
    frozenReason: b.frozenReason,
  };
}

function toBudget(b: BackendBudget): Budget {
  return {
    spentToday: Number(b.committedTodayUsdc),
    spentTodayLabel: b.committedTodayUsdc,
    remainingToday: Number(b.remainingTodayUsdc),
    remainingTodayLabel: b.remainingTodayUsdc,
    dailyCap: Number(b.dailyCapUsdc),
    dailyCapLabel: b.dailyCapUsdc,
    availableFunds: b.availableFundsUsdc === null ? null : Number(b.availableFundsUsdc),
    availableFundsLabel: b.availableFundsUsdc,
    day: b.day,
    timeZone: b.timeZone,
  };
}

const MOVEMENT_LABEL: Record<string, string> = {
  top_up: "Top-up into the agent wallet",
  gateway_deposit: "Deposit into Circle Gateway",
  gateway_withdrawal: "Withdrawal from Circle Gateway",
  unexpected_outbound: "Unexpected transfer out of the agent wallet",
  unrelated: "Other USDC transfer",
};

function toMovement(m: ChainMovement): Movement {
  return {
    id: m.canonicalId,
    kind: m.classification,
    label: MOVEMENT_LABEL[m.classification] ?? m.classification,
    amountLabel: m.amountUsdc,
    txHash: m.txHash,
    explorerUrl: m.explorer ?? EXPLORER_TX_URL(m.txHash),
    block: m.block ?? null,
    observedAt: m.observedAt,
    alert: m.classification === "unexpected_outbound",
  };
}

// ---------------------------------------------------------------------------
// Conversation with the server-side assistant
// ---------------------------------------------------------------------------
// The conversation id survives a page refresh (sessionStorage, this tab only) so the chat can be
// restored from GET /api/chat/:id. It's not a credential: reading a transcript needs a session.
const CONVERSATION_KEY = "allowance.conversationId";
const storage = (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();
let conversationId = storage?.getItem(CONVERSATION_KEY) || crypto.randomUUID();
storage?.setItem(CONVERSATION_KEY, conversationId);

let inflight: AbortController | null = null;
/** Purchases the assistant made in the current conversation, so it can explain their outcome. */
const conversationPurchases = new Set<string>();
const reported = new Set<string>();

const STATUS_OF_REPLY: Record<string, ChatStatus> = {
  ok: "done",
  approval_required: "approval",
  refused: "done", // the assistant explained why it didn't buy; that's a normal answer
  incomplete: "incomplete",
  error: "error",
};
const toReply = (r: ChatReply): AgentReply => ({ text: r.reply, status: (STATUS_OF_REPLY[r.status] ?? "done") as AgentReply["status"] });

function remember(r: ChatReply) {
  for (const p of r.purchases) {
    conversationPurchases.add(p.purchaseId);
    describePurchase(p.purchaseId, `${itemTitle(p.item)}: ${p.title ?? p.ticker}`);
  }
}

function errorReply(err: unknown): AgentReply {
  if (err instanceof LoginCancelled) return { text: "Log in with the demo access code to chat with the assistant.", status: "error" };
  if (err instanceof ApiError) {
    // The backend's message already says whether anything was bought.
    const purchases = (err.body.purchases as ChatReply["purchases"] | undefined) ?? [];
    purchases.forEach((p) => conversationPurchases.add(p.purchaseId));
    return { text: err.message, status: "error" };
  }
  return { text: "I couldn't reach the Allowance backend. If a purchase had already gone through, it appears under Payments.", status: "error" };
}

/**
 * One spoken turn (see voiceTurns.ts): the person's finalized transcript goes to the same server-side
 * Claude conversation as the chat panel, so spoken purchases pass the same purchase gate, policy and
 * approvals as typed ones. `messageId` is fixed per turn, so a repeat returns the stored answer instead
 * of running the turn (or a purchase in it) again. Never aborted: a purchase already submitted stands.
 */
export async function askFromVoice(text: string, messageId: string): Promise<VoiceReply> {
  const request = text.trim();
  if (!request) return { text: "I didn't catch that. Could you say it again?", status: "done" };
  const forConversation = conversationId;
  try {
    const r = await backend.chat(forConversation, messageId, request);
    remember(r);
    return { ...toReply(r), current: forConversation === conversationId };
  } catch (err) {
    return { ...errorReply(err), current: forConversation === conversationId };
  } finally {
    refreshNow();
  }
}

/** A held purchase from this conversation was decided: let the assistant explain the outcome (it can't buy on this). */
async function reportOutcome(purchaseId: string) {
  if (!conversationPurchases.has(purchaseId) || reported.has(purchaseId)) return;
  reported.add(purchaseId);
  const forConversation = conversationId;
  try {
    const r = await backend.chatEvent(forConversation, crypto.randomUUID(), purchaseId);
    if (forConversation === conversationId) emit({ type: "agent_message", text: r.reply });
  } catch (err) {
    if (forConversation === conversationId) notice(errorReply(err).text, "warn");
  }
}

const seen = new Map<string, string>();
let openApproval: string | null = null;

export function applyPurchase(p: Purchase) {
  const key = `${p.state}|${p.settlementTx ?? ""}`;
  if (seen.get(p.id) === key) return;
  const before = seen.get(p.id)?.split("|")[0];
  seen.set(p.id, key);

  emit({ type: "payment", payment: toPayment(p) });

  const live = p.state === "awaiting_approval" && (p.approvalExpiresAt === null || p.approvalExpiresAt > Date.now());
  if (live) {
    openApproval = p.id;
    const what = descriptions.get(p.id) ?? itemTitle(p.item);
    emit({
      type: "approval_request",
      request: {
        id: p.id,
        seller: sellerName(p.seller),
        amount: Number(p.priceUsdc),
        amountLabel: p.priceUsdc,
        reason: p.reason ? `${what}. ${p.reason}.` : what,
        expiresAt: p.approvalExpiresAt,
      },
    });
  } else if (before === "awaiting_approval" || openApproval === p.id) {
    if (openApproval === p.id) openApproval = null;
    emit({ type: "approval_resolved", id: p.id });
    void reportOutcome(p.id);
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
let started = false;
let timer = 0;
let failures = 0;
let lastFrozen: boolean | undefined;
const seenMovements = new Set<string>();
let movementsLoaded = false;
let connection: Connection | null = null;

function setConnection(next: Connection) {
  if (next === connection) return;
  const was = connection;
  connection = next;
  emit({ type: "connection", connection: next });
  if (next === "expired" && was === "connected") notice("Your session expired, so the dashboard stopped updating. Log in again to continue.", "warn");
}

const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;

function applyMovements(list: ChainMovement[]) {
  const movements = list.map(toMovement);
  emit({ type: "movements", movements });
  for (const m of [...movements].reverse()) {
    if (seenMovements.has(m.id)) continue;
    seenMovements.add(m.id);
    // Only transfers that arrive while the page is open; history is in the Onchain activity card.
    if (movementsLoaded) {
      notice(`QuickNode Streams saw: ${m.label.toLowerCase()}, ${m.amountLabel} USDC (tx ${shortHash(m.txHash)}).`, m.alert ? "warn" : "info");
    }
  }
  movementsLoaded = true;
}

function applyBudget(b: BackendBudget) {
  emit({ type: "rules", rules: toRules(b) });
  emit({ type: "budget", budget: toBudget(b) });
  if (lastFrozen !== undefined && lastFrozen !== b.frozen) {
    const text = b.frozen
      ? `Spending is frozen: ${b.frozenReason ?? "no reason given"}. Nothing can be bought until an operator unfreezes it.`
      : "Spending is unfrozen. The assistant can buy data again, within the rules.";
    notice(text, b.frozen ? "warn" : "info");
    voice.controls()?.context(text);
  }
  lastFrozen = b.frozen;
}

let busy = false;
async function tick() {
  window.clearTimeout(timer);
  if (busy) return;
  busy = true;
  let active = false;
  try {
    if (hasSession("agent") || hasSession("operator")) {
      if (!catalog.length) catalog = (await backend.pollCatalog()) ?? [];
      const [purchases, budget, movements] = await Promise.all([backend.pollPurchases(20), backend.pollBudget(), backend.pollMovements(20)]);
      if (purchases) {
        for (const p of [...purchases].reverse()) applyPurchase(p);
        active = purchases.some((p) => p.state === "awaiting_approval" || IN_FLIGHT.has(p.state));
      }
      if (budget) applyBudget(budget);
      if (movements) applyMovements(movements);
      setConnection("connected");
    } else {
      setConnection(hasLoggedInBefore() ? "expired" : "logged_out");
    }
    failures = 0;
  } catch (err) {
    if (err instanceof SessionExpired) {
      setConnection("expired");
    } else {
      failures++;
      setConnection("unreachable");
    }
  } finally {
    busy = false;
  }
  // 3 s while something is in flight or awaiting approval, otherwise 5 s; back off on errors up to 30 s.
  const delay = failures ? Math.min(30_000, 1000 * 2 ** failures) : active ? 3000 : 5000;
  timer = window.setTimeout(tick, delay);
}
export const refreshNow = () => void tick();

function startPolling() {
  if (started) return;
  started = true;
  onLogin(() => refreshNow());
  refreshNow();
}

let loggedIn: Promise<void> | null = null;
const whenLoggedIn = () =>
  (loggedIn ??= new Promise<void>((resolve) => {
    if (hasSession("agent") || hasSession("operator")) return resolve();
    const off = onLogin(() => {
      off();
      resolve();
    });
  }));

const fromTranscript = (m: TranscriptEntry): ChatMessage => ({
  id: m.id,
  from: m.from,
  text: m.text,
  at: m.at,
  status: m.from === "agent" ? (STATUS_OF_REPLY[m.status ?? "ok"] ?? "done") : undefined,
  spoken: true, // already shown (and read aloud) before the refresh
});

// ---------------------------------------------------------------------------
// Api
// ---------------------------------------------------------------------------
export const real: Api = {
  async getRules() {
    await whenLoggedIn();
    await getCatalog();
    return toRules(await backend.budget());
  },
  async saveRules() {
    throw new Error("Spending rules are set on the backend; only the server owner can change them.");
  },
  async decideApproval(id, approve) {
    try {
      // Operator credential, asked for here only. The assistant has no way to approve.
      const p = approve ? await backend.approve(id) : await backend.decline(id);
      applyPurchase(p); // the approval leaves awaiting_approval, so the assistant explains the outcome
      voice.controls()?.context(approve ? `The person approved purchase ${id}.` : `The person declined purchase ${id}.`);
    } catch (err) {
      if (err instanceof LoginCancelled) return; // card stays open
      if (err instanceof ApiError && err.code === "invalid_state") {
        notice("That approval is no longer open (it was already decided or it expired).", "warn");
        emit({ type: "approval_resolved", id });
      } else {
        notice(`Couldn't record that decision: ${(err as Error).message}`, "warn");
      }
    } finally {
      refreshNow();
    }
  },
  async sendMessage(text) {
    inflight?.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    // A new id per message: if this request is retried, the backend returns the stored answer
    // instead of running it (or any purchase in it) again.
    const messageId = crypto.randomUUID();
    try {
      const r = await backend.chat(conversationId, messageId, text, ctrl.signal);
      remember(r);
      return toReply(r);
    } catch (err) {
      if (ctrl.signal.aborted) {
        return { text: "Stopped waiting for that answer. If a purchase had already been submitted, it still stands and shows under Payments.", status: "canceled" };
      }
      return errorReply(err);
    } finally {
      if (inflight === ctrl) inflight = null;
      refreshNow();
    }
  },
  cancel() {
    inflight?.abort();
  },
  newChat() {
    inflight?.abort();
    conversationId = crypto.randomUUID();
    storage?.setItem(CONVERSATION_KEY, conversationId);
    conversationPurchases.clear();
  },
  async restoreChat() {
    await whenLoggedIn();
    const forConversation = conversationId;
    try {
      const messages = await backend.transcript(forConversation);
      if (forConversation !== conversationId) return [];
      // One entry per id, even if a retried request was logged twice.
      const unique = [...new Map(messages.map((m) => [m.id, m])).values()];
      return unique.map(fromTranscript);
    } catch {
      return []; // nothing to restore (new conversation, or the backend can't read it); start fresh
    }
  },
  subscribe(listener) {
    listeners.add(listener);
    startPolling();
    return () => {
      listeners.delete(listener);
    };
  },
  async connect() {
    try {
      await token("agent");
      refreshNow();
      return true;
    } catch (err) {
      if (err instanceof LoginCancelled) return false;
      throw err;
    }
  },
  async setFrozen(frozen) {
    try {
      if (frozen) await backend.freeze("Frozen from the Allowance dashboard");
      else await backend.unfreeze();
    } catch (err) {
      if (!(err instanceof LoginCancelled)) notice(`Couldn't change the freeze: ${(err as Error).message}`, "warn");
    } finally {
      refreshNow();
    }
  },
};
