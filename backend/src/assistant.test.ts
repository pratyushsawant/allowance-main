/**
 * Assistant with a scripted fake model: the model can misbehave (try to buy on "wait", buy twice,
 * invent tickers), and the server-side gate must still hold. Real ledger, policy and recorder data;
 * the seller is a stub, so no network, no LLM spend and no USDC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { AssistantError, createAssistant, purchaseBlockedFor, type ModelClient } from "./assistant.ts";
import type { Buyer } from "./buyer.ts";
import { ARC_TESTNET } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createLedger } from "./ledger.ts";
import { createMarketData } from "./market-data.ts";
import type { PolicyConfig } from "./policy.ts";
import { createRecorder } from "./recorder.ts";

const SELLER = "0x3b53b70d0275e5b2f8a3DFe6Cb0d949B3D7Ea14e";
const UNLISTED = "0xc0010000000000000000000000000000000063290";
const CONV = "conv-1234-abcd";
let seq = 0;
const mid = () => `msg-${String(++seq).padStart(6, "0")}`;

type Block = Record<string, unknown>;
const reply = (content: Block[], stop_reason: string) =>
  ({ id: `m${seq}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason, stop_sequence: null, usage: {} }) as unknown as Anthropic.Beta.BetaMessage;
const text = (t: string) => reply([{ type: "text", text: t }], "end_turn");
let toolSeq = 0;
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `tu_${++toolSeq}`, name, input });
const toolCalls = (...calls: Block[]) => reply(calls, "tool_use");

/** A model that plays back a script and records every request. */
function scripted(steps: Array<Anthropic.Beta.BetaMessage | Error>) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const model: ModelClient = {
    async create(params) {
      calls.push(structuredClone(params));
      const next = steps.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { model, calls };
}

/** Tool results the model received in its last request. */
const toolResults = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
  const last = params.messages.at(-1)!;
  return (last.content as Array<{ type: string; content: string; is_error?: boolean }>).filter((b) => b.type === "tool_result");
};

async function setup(opts: { frozen?: boolean; model?: ModelClient | null } = {}) {
  const db = openDatabase(":memory:");
  const clock = Date.UTC(2026, 10, 20, 14, 0);
  await createRecorder(db, {
    now: () => clock,
    fetchPage: async (offset, limit) => ({
      data: offset
        ? []
        : [
            { id: "1", ticker: "BTC-TODAY", title: "BTC price today at 9am EST", category: "Crypto",
              contracts: [{ id: "a", label: "Up", instrumentSymbol: "GEMI-BTC-UP", prices: { bestBid: "0.59", bestAsk: "0.61" } }] },
            { id: "2", ticker: "MINN-OKST", title: "Minnesota vs Oklahoma State", category: "Sports",
              contracts: [{ id: "b", label: "Minnesota", instrumentSymbol: "GEMI-MINN", prices: { bestBid: "0.51", bestAsk: "0.52" } }] },
          ],
      pagination: { limit, offset, total: 2 },
    }),
    pageDelayMs: 0,
    log: () => {},
  }).pollOnce();

  const policy: PolicyConfig = {
    network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, decimals: 6, allowedPayees: [SELLER],
    autoApproveMax: 250_000n, perCallMax: 1_000_000n, dailyCap: 2_000_000n, timeZone: "America/Chicago",
  };
  const ledger = createLedger(db, policy, { now: () => clock });
  if (opts.frozen) ledger.setFrozen(true, "Paused for a test");
  const PRICES: Record<string, bigint> = { odds_snapshot: 5_000n, odds_history: 20_000n, deep_brief: 750_000n, full_report: 10_000n };
  const buyerCalls: string[] = [];
  const buyer = {
    // Stub seller: the real policy and ledger decide; an allowed purchase is marked paid.
    purchase: async (r: { idempotencyKey: string; itemId: string; sellerId: string; resourceUrl: string }) => {
      buyerCalls.push(r.idempotencyKey);
      const payTo = r.sellerId === "shady-reports" ? UNLISTED : SELLER;
      const { purchase } = ledger.reserve({ ...r, quote: { payTo, network: policy.network, asset: policy.asset, amount: PRICES[r.itemId] }, gatewayAvailable: 5_000_000n });
      if (purchase.state !== "reserved") return purchase;
      return ledger.transition(purchase.id, ["reserved"], "accepted", {
        reason: "Paid",
        result: { event: { title: "BTC price today at 9am EST", contracts: [{ label: "Up", bestBid: "0.59", bestAsk: "0.61" }] } },
      });
    },
  } as unknown as Buyer;
  const make = (model: ModelClient | null) =>
    createAssistant({
      db, ledger, buyer, market: createMarketData(db, () => clock), policy, publicBaseUrl: "http://127.0.0.1:1",
      gatewayAvailable: async () => 5_000_000n, model, modelId: "claude-sonnet-5-5", now: () => clock,
    });
  return { db, ledger, buyerCalls, make };
}

test("messages that can never authorize a purchase", () => {
  for (const t of ["wait", "Wait!", "wait, actually", "stop", "stop that", "cancel it", "never mind", "nevermind", "hold on", "don't buy that", "hi", "Hello there", "hey!", "thanks", "thank you!", "no"]) {
    assert.notEqual(purchaseBlockedFor(t), null, `should block: ${t}`);
  }
  // "yes"/"ok" can confirm a purchase the assistant just offered, so they are left to the model.
  for (const t of ["What are the BTC odds right now?", "yes", "yes please", "ok", "no, get me the BTC odds", "Get me a deep brief on Minnesota", "hi, what are the BTC odds?"]) {
    assert.equal(purchaseBlockedFor(t), null, `should not block: ${t}`);
  }
});

test("Hello: a conversational reply, no tools, no purchase", async () => {
  const s = await setup();
  const { model, calls } = scripted([text("Hi! I can look up Gemini prediction markets for you.")]);
  const r = await s.make(model).chat({ conversationId: CONV, messageId: mid(), text: "Hello" });
  assert.equal(r.reply, "Hi! I can look up Gemini prediction markets for you.");
  assert.equal(r.status, "ok");
  assert.deepEqual(r.purchases, []);
  assert.equal(s.ledger.recent(10).length, 0);
  assert.equal(calls[0].model, "claude-sonnet-5-5");
  assert.equal(calls[0].fallbacks, "default");
  assert.ok(calls[0].tools?.some((t) => "name" in t && t.name === "buy_market_data"));
});

test("wait / stop: even if the model tries to buy, nothing is bought", async () => {
  for (const word of ["wait", "stop"]) {
    const s = await setup();
    const { model, calls } = scripted([
      toolCalls(tool("search_markets", { query: "BTC" })),
      toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: word })),
      text("Okay, I'll hold off."),
    ]);
    const r = await s.make(model).chat({ conversationId: CONV, messageId: mid(), text: word });
    const [refusal] = toolResults(calls[2]);
    assert.equal(refusal.is_error, true);
    assert.match(refusal.content, /wait, stop or cancel/);
    assert.deepEqual(r.purchases, []);
    assert.equal(s.buyerCalls.length, 0, `${word} must not reach the buyer`);
  }
});

test("explicit request: at most one purchase per message, and only for a ticker found in this conversation", async () => {
  const s = await setup();
  const { model, calls } = scripted([
    toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: "odds" })), // not searched yet
    toolCalls(tool("search_markets", { query: "BTC" })),
    toolCalls(
      tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: "current BTC odds" }),
      tool("buy_market_data", { item: "odds_history", ticker: "BTC-TODAY", request: "current BTC odds" }),
    ),
    text("BTC is about 60% Up as of 8:00 AM."),
  ]);
  const r = await s.make(model).chat({ conversationId: CONV, messageId: mid(), text: "What are the BTC odds right now?" });
  assert.match(toolResults(calls[1])[0].content, /hasn't come up in this conversation/);
  const [first, second] = toolResults(calls[3]);
  assert.notEqual(first.is_error, true);
  assert.match(first.content, /"state":"accepted"/);
  assert.equal(second.is_error, true);
  assert.match(second.content, /only one purchase per message/);
  assert.equal(r.purchases.length, 1);
  assert.equal(s.buyerCalls.length, 1);
  assert.match(s.buyerCalls[0], /^chat:[0-9a-f]{40}$/);
  // Search results never carry prices.
  assert.doesNotMatch(toolResults(calls[2])[0].content, /0\.59|0\.61|bestBid/);
});

test("the same message id again returns the stored reply: no model call, no second charge", async () => {
  const s = await setup();
  const { model, calls } = scripted([
    toolCalls(tool("search_markets", { query: "BTC" })),
    toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: "BTC odds" })),
    text("About 60% Up."),
  ]);
  const a = s.make(model);
  const id = mid();
  const first = await a.chat({ conversationId: CONV, messageId: id, text: "BTC odds now please" });
  const again = await a.chat({ conversationId: CONV, messageId: id, text: "BTC odds now please" });
  assert.equal(again.replayed, true);
  assert.equal(again.reply, first.reply);
  assert.equal(calls.length, 3, "no extra model calls");
  assert.equal(s.ledger.recent(10).length, 1, "one charge");
});

test("follow-up explanation reuses the earlier result and keeps the conversation", async () => {
  const s = await setup();
  const { model, calls } = scripted([
    toolCalls(tool("search_markets", { query: "BTC" })),
    toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: "BTC odds" })),
    text("About 60% Up."),
    toolCalls(tool("list_purchases", {})),
    text("That 60% is the midpoint of the 0.59 bid and 0.61 ask."),
  ]);
  const a = s.make(model);
  await a.chat({ conversationId: CONV, messageId: mid(), text: "What are the BTC odds right now?" });
  const r = await a.chat({ conversationId: CONV, messageId: mid(), text: "Explain your last answer" });
  assert.deepEqual(r.purchases, []);
  assert.equal(s.ledger.recent(10).length, 1);
  assert.ok(calls[3].messages.length > 1, "history is sent with the follow-up");
  assert.match(toolResults(calls[4])[0].content, /"summary":"BTC price today/);
});

test("deep brief over the auto-approve limit waits for a person", async () => {
  const s = await setup();
  const { model } = scripted([
    toolCalls(tool("search_markets", { query: "Minnesota" })),
    toolCalls(tool("buy_market_data", { item: "deep_brief", ticker: "MINN-OKST", request: "deep brief on Minnesota" })),
    text("That brief costs 0.75 USDC, so it needs your approval in the app."),
  ]);
  const r = await s.make(model).chat({ conversationId: CONV, messageId: mid(), text: "Get me a deep brief on Minnesota" });
  assert.equal(r.status, "approval_required");
  assert.equal(r.purchases[0].state, "awaiting_approval");
  assert.equal(s.ledger.get(r.purchases[0].purchaseId)?.nonce, null, "nothing signed");
});

test("frozen spending and an unlisted seller are refused by the existing policy", async () => {
  const frozen = await setup({ frozen: true });
  let script = scripted([
    toolCalls(tool("search_markets", { query: "BTC" })),
    toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: "BTC odds" })),
    text("Spending is frozen, so I can't buy that."),
  ]);
  const a = await frozen.make(script.model).chat({ conversationId: CONV, messageId: mid(), text: "BTC odds now" });
  assert.equal(a.purchases[0].state, "blocked");
  assert.match(toolResults(script.calls[2])[0].content, /frozen/i);

  const s = await setup();
  script = scripted([
    toolCalls(tool("search_markets", { query: "BTC" })),
    toolCalls(tool("buy_market_data", { item: "full_report", ticker: "BTC-TODAY", request: "full report" })),
    text("That seller isn't on your allowlist."),
  ]);
  const b = await s.make(script.model).chat({ conversationId: CONV, messageId: mid(), text: "Get me the full report on BTC" });
  assert.equal(b.purchases[0].state, "blocked");
  assert.match(toolResults(script.calls[2])[0].content, /allowlist/);
});

test("app events never buy", async () => {
  const s = await setup();
  const first = scripted([
    toolCalls(tool("search_markets", { query: "Minnesota" })),
    toolCalls(tool("buy_market_data", { item: "deep_brief", ticker: "MINN-OKST", request: "brief" })),
    text("Needs your approval."),
    toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "MINN-OKST", request: "event" })),
    text("You declined it, so nothing was paid."),
  ]);
  const a = s.make(first.model);
  const held = await a.chat({ conversationId: CONV, messageId: mid(), text: "Get me a deep brief on Minnesota" });
  s.ledger.decline(held.purchases[0].purchaseId);
  const r = await a.purchaseUpdate({ conversationId: CONV, messageId: mid(), purchaseId: held.purchases[0].purchaseId });
  assert.match(toolResults(first.calls[4])[0].content, /only follow the person's own message/);
  assert.deepEqual(r.purchases, []);
  assert.equal(s.ledger.recent(10).length, 1);
});

test("no API key, model failure and replays: clear errors, never a fallback purchase", async () => {
  const s = await setup();
  await assert.rejects(s.make(null).chat({ conversationId: CONV, messageId: mid(), text: "BTC odds" }), (e: AssistantError) => {
    assert.equal(e.status, 503);
    assert.equal(e.code, "assistant_not_configured");
    return true;
  });

  const { model, calls } = scripted([
    toolCalls(tool("search_markets", { query: "BTC" })),
    toolCalls(tool("buy_market_data", { item: "odds_snapshot", ticker: "BTC-TODAY", request: "BTC odds" })),
    new Error("upstream timeout"),
  ]);
  const a = s.make(model);
  const id = mid();
  let failure: AssistantError | undefined;
  await assert.rejects(a.chat({ conversationId: CONV, messageId: id, text: "BTC odds right now" }), (e: AssistantError) => (failure = e) !== undefined);
  assert.equal(failure!.purchases.length, 1, "a purchase made before the failure is reported, not hidden");
  assert.match(failure!.message, /still stands/);
  await assert.rejects(a.chat({ conversationId: CONV, messageId: id, text: "BTC odds right now" }), (e: AssistantError) => e.code === failure!.code);
  assert.equal(calls.length, 3, "a failed message is not re-run");
  assert.equal(s.ledger.recent(10).length, 1);
  assert.equal(s.buyerCalls.length, 1);
});
