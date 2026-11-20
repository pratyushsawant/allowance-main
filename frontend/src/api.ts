// The UI's view of the backend. Normally realApi.ts talks to the Allowance backend (Railway).
// With USE_MOCK (VITE_USE_MOCK=1) the fake backend below drives the whole UI offline instead: every
// mock reply says "(Mock mode)" and the app shows a "Demo data" badge. Never deploy with it on.

import { USE_MOCK } from "./config";
import { real } from "./realApi";
import type { AgentReply, ApprovalRequest, ChatMessage, MarketData, Payment, Rules, ServerEvent } from "./types";

export type Listener = (e: ServerEvent) => void;

export type Api = {
  getRules(): Promise<Rules>;
  saveRules(rules: Rules): Promise<Rules>;
  decideApproval(id: string, approve: boolean): Promise<void>;
  /** One chat message to the assistant; resolves with its answer (never throws). */
  sendMessage(text: string): Promise<AgentReply>;
  /** Stop waiting for the current answer. A payment already submitted still stands. */
  cancel(): void;
  /** Start a new conversation. Payments, approvals and budget are unaffected. */
  newChat(): void;
  /** The current conversation so far (after a page refresh), once logged in. */
  restoreChat(): Promise<ChatMessage[]>;
  subscribe(listener: Listener): () => void; // returns an unsubscribe function
  /** Log in (asks for the access code). Resolves false if the person cancels. */
  connect(): Promise<boolean>;
  /** Spending kill switch (operator). */
  setFrozen(frozen: boolean): Promise<void>;
};

// ---------------------------------------------------------------------------
// Mock backend — pretends to be the agent + chain so the UI works with no backend
// ---------------------------------------------------------------------------
const listeners = new Set<Listener>();
const emit = (e: ServerEvent) => listeners.forEach((l) => l(e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomHex = (n: number) =>
  "0x" + Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

// Same seller, prices and default limits as the real backend (backend/src/catalog.ts, .env.example).
let mockRules: Rules = {
  allowlist: ["Odds Desk"],
  perRequestCap: 1.0,
  dailyBudget: 2.0,
  approvalThreshold: 0.25,
  editable: true,
  frozen: false,
};
let spentToday = 0;
const pending = new Map<string, ApprovalRequest & { data: MarketData }>();

const fakeMarkets: MarketData[] = [
  { market: "Will BTC close above $100k on Dec 31?", yesPrice: 0.62, volume: 184_200 },
  { market: "Will the Fed cut rates in December?", yesPrice: 0.41, volume: 96_800 },
  { market: "Will ETH flip $5k before 2027?", yesPrice: 0.28, volume: 51_300 },
];

/** A purchase that was refused or declined: shown in the list, nothing charged. */
function mockNotCharged(seller: string, amount: number, state: "blocked" | "declined", reason: string) {
  emit({
    type: "payment",
    payment: { id: crypto.randomUUID(), seller, amount, amountLabel: String(amount), txHash: "", status: "not_charged", state, reason, timestamp: Date.now(), itemTitle: "(Mock) purchase" },
  });
}

async function mockPay(seller: string, amount: number, data: MarketData) {
  const payment: Payment = {
    id: crypto.randomUUID(),
    seller,
    amount,
    amountLabel: String(amount),
    itemTitle: amount >= 0.25 ? "(Mock) Deep brief" : "(Mock) Odds snapshot",
    txHash: "",
    status: "pending",
    timestamp: Date.now(),
  };
  emit({ type: "payment", payment });
  await wait(1500);
  spentToday += amount;
  // A fake tx hash, so the "Settled on Arc" state can be seen offline. It's random, not onchain.
  emit({ type: "payment", payment: { ...payment, status: "confirmed", txHash: randomHex(64), data } });
  return `"${data.market}" is trading at ${Math.round(data.yesPrice * 100)}% yes (mock data).`;
}

const mock: Api = {
  async getRules() {
    await wait(200);
    return { ...mockRules };
  },
  async saveRules(rules) {
    await wait(200);
    mockRules = { ...rules };
    return { ...mockRules };
  },
  async decideApproval(id, approve) {
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    emit({ type: "approval_resolved", id });
    if (!approve) mockNotCharged(req.seller, req.amount, "declined", "Declined by a person");
    emit({ type: "agent_message", text: approve ? await mockPay(req.seller, req.amount, req.data) : "(Mock mode) Okay, I won't buy that." });
  },
  // Offline demo only: a scripted stand-in, clearly not the real assistant.
  async sendMessage(text) {
    await wait(600);
    if (/^\W*(wait|stop|cancel|never ?mind|hi|hello|hey|thanks)\b/i.test(text)) return { text: "(Mock mode) Okay. Nothing was bought.", status: "done" };
    const big = /report|deep|brief|full/i.test(text);
    const seller = "Odds Desk";
    const amount = big ? 0.75 : 0.005;
    const data =
      (/btc|bitcoin/i.test(text) && fakeMarkets[0]) ||
      (/fed|rate/i.test(text) && fakeMarkets[1]) ||
      (/eth/i.test(text) && fakeMarkets[2]) ||
      fakeMarkets[0];
    if (mockRules.frozen) {
      mockNotCharged(seller, amount, "blocked", "Spending is frozen");
      return { text: "(Mock mode) Spending is frozen, so I can't buy anything. Nothing was charged.", status: "done" };
    }
    if (!mockRules.allowlist.includes(seller)) return { text: `(Mock mode) I can't pay ${seller}; it's not on your allowlist.`, status: "done" };
    if (amount > mockRules.perRequestCap) return { text: "(Mock mode) That's over your per-request cap.", status: "done" };
    if (spentToday + amount > mockRules.dailyBudget) return { text: "(Mock mode) That would go over today's budget.", status: "done" };
    if (amount > mockRules.approvalThreshold) {
      const req = { id: crypto.randomUUID(), seller, amount, amountLabel: String(amount), reason: `(Mock) Deep brief for "${data.market}"`, expiresAt: Date.now() + 10 * 60_000, data };
      pending.set(req.id, req);
      emit({ type: "approval_request", request: req });
      return { text: `(Mock mode) This one costs ${amount} USDC, so I need your OK.`, status: "approval" };
    }
    return { text: await mockPay(seller, amount, data), status: "done" };
  },
  cancel() {},
  newChat() {},
  async restoreChat() {
    return [];
  },
  subscribe(listener) {
    listeners.add(listener);
    listener({ type: "connection", connection: "connected" });
    return () => listeners.delete(listener);
  },
  async connect() {
    return true;
  },
  async setFrozen(frozen) {
    mockRules = { ...mockRules, frozen, frozenReason: frozen ? "Frozen from the dashboard (mock)" : null };
    emit({ type: "rules", rules: { ...mockRules } });
  },
};

export const api: Api = USE_MOCK ? mock : real;
