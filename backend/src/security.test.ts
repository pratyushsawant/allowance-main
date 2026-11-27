/**
 * Security regression tests (audit of 2026-11-23). Each test performs the attack against the real
 * router/API over HTTP and checks that it no longer works:
 *   - numeric query input: decimals, negatives and huge values for `limit` never cause a 500
 *   - login lockout: keyed per client behind the proxy (X-Real-IP), not per proxy address; the header
 *     is ignored unless trusted; a global backstop still applies
 *   - cost abuse: /api/chat and /api/voice/session are rate-limited per client and in total, and new
 *     conversation ids don't reset the limit
 *   - security headers on every JSON response
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerApi, type ApiDeps } from "./api.ts";
import type { Assistant } from "./assistant.ts";
import { clientAddress, createAuth } from "./auth.ts";
import type { Buyer } from "./buyer.ts";
import { ARC_TESTNET } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createRouter, parseLimit } from "./http.ts";
import { createLedger } from "./ledger.ts";
import { createMarketData } from "./market-data.ts";
import type { PolicyConfig } from "./policy.ts";
import { createSessionSigner } from "./session.ts";
import { createVoiceSessions } from "./voice.ts";

const SELLER = "0x3b53b70d0275e5b2f8a3DFe6Cb0d949B3D7Ea14e";
const AGENT_TOKEN = "a".repeat(64);
const OPERATOR_TOKEN = "o".repeat(64);
const CODES = { agent: "agent-code-123", operator: "operator-code-456" };

const servers: Server[] = [];
after(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

/** A fresh API server (own limiters) with stubbed assistant, voice and buyer. Nothing is paid. */
async function start(extra: Partial<ApiDeps> = {}) {
  const db = openDatabase(":memory:");
  const policy: PolicyConfig = {
    network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, decimals: 6, allowedPayees: [SELLER],
    autoApproveMax: 250_000n, perCallMax: 1_000_000n, dailyCap: 5_000_000n, timeZone: "America/Chicago",
  };
  const ledger = createLedger(db, policy);
  const sessions = createSessionSigner("s".repeat(64));
  let chats = 0;
  const assistant = {
    status: () => ({ configured: true, model: "claude-test", problem: null }),
    chat: async (i: { conversationId: string; messageId: string }) => {
      chats++;
      return { conversationId: i.conversationId, messageId: i.messageId, reply: "ok", status: "ok", purchases: [], at: 0 };
    },
    purchaseUpdate: async () => ({ reply: "ok" }),
    transcript: () => [],
  } as unknown as Assistant;
  const router = createRouter(() => {});
  registerApi(router, {
    ledger,
    buyer: {} as Buyer,
    market: createMarketData(db),
    policy,
    publicBaseUrl: "http://127.0.0.1:1",
    auth: createAuth({ agentToken: AGENT_TOKEN, operatorToken: OPERATOR_TOKEN, sessions }),
    sessions,
    accessCodes: CODES,
    sessionTtlSeconds: { agent: 60, operator: 60 },
    voice: createVoiceSessions({
      apiKey: "xi-test-key-not-real",
      agentId: "agent_test123",
      fetchImpl: (async () => new Response(JSON.stringify({ token: "t", conversation_id: "c" }), { status: 200 })) as unknown as typeof fetch,
    }),
    gatewayAvailable: async () => 5_000_000n,
    assistant,
    ...extra,
  });
  const server = createServer((req, res) => void router.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, o: { token?: string; body?: unknown; ip?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.ip) headers["x-real-ip"] = o.ip;
    const res = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { call, chats: () => chats };
}

const chat = (n: number) => ({ conversationId: `conv-${n}-aaaaaaaa`, messageId: `msg-${n}-aaaaaaaa`, text: "BTC odds?" });

test("numeric input: decimal, negative, huge or junk `limit` values never cause a server error", async () => {
  const { call } = await start();
  for (const limit of ["1.5", "-1", "0", "99999999", "1e9", "abc", "NaN", "Infinity", "2.0000001"]) {
    const r = await call("GET", `/api/purchases?limit=${limit}`, { token: AGENT_TOKEN });
    assert.equal(r.status, 200, `limit=${limit} answered ${r.status}`);
    assert.ok(Array.isArray(r.json.purchases));
  }
});

test("login lockout is per client behind the proxy: one client's failures don't lock out everyone", async () => {
  const { call } = await start({ clientIpHeader: "x-real-ip" });
  for (let i = 0; i < 10; i++) {
    assert.equal((await call("POST", "/api/sessions", { body: { scope: "agent", accessCode: "wrong-guess" }, ip: "203.0.113.9" })).status, 401);
  }
  const attacker = await call("POST", "/api/sessions", { body: { scope: "agent", accessCode: CODES.agent }, ip: "203.0.113.9" });
  assert.equal(attacker.status, 429, "the guessing client is locked out, even with the right code");
  const someoneElse = await call("POST", "/api/sessions", { body: { scope: "agent", accessCode: CODES.agent }, ip: "198.51.100.7" });
  assert.equal(someoneElse.status, 200, "another client can still log in");
});

test("a client can't dodge the lockout by sending its own X-Real-IP when that header isn't trusted", async () => {
  const { call } = await start(); // no clientIpHeader: the socket address is the key
  for (let i = 0; i < 10; i++) {
    await call("POST", "/api/sessions", { body: { scope: "agent", accessCode: "wrong-guess" }, ip: `203.0.113.${i}` });
  }
  const r = await call("POST", "/api/sessions", { body: { scope: "agent", accessCode: "wrong-guess" }, ip: "203.0.113.200" });
  assert.equal(r.status, 429);
});

test("login: a global cap on failures still applies when guesses come from many addresses", async () => {
  const { call } = await start({ clientIpHeader: "x-real-ip", limits: { loginFailuresTotal: { limit: 5, windowMs: 60_000 } } });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call("POST", "/api/sessions", { body: { scope: "operator", accessCode: "guess" }, ip: `192.0.2.${i}` })).status, 401);
  }
  assert.equal((await call("POST", "/api/sessions", { body: { scope: "operator", accessCode: "guess" }, ip: "192.0.2.99" })).status, 429);
});

test("chat cost abuse: new conversation ids don't reset the per-client limit", async () => {
  const { call, chats } = await start({ clientIpHeader: "x-real-ip", limits: { chatPerClient: { limit: 3, windowMs: 60_000 } } });
  for (let n = 0; n < 3; n++) assert.equal((await call("POST", "/api/chat", { token: AGENT_TOKEN, body: chat(n), ip: "203.0.113.5" })).status, 200);
  const over = await call("POST", "/api/chat", { token: AGENT_TOKEN, body: chat(99), ip: "203.0.113.5" });
  assert.equal(over.status, 429);
  assert.equal(over.json.error, "rate_limited");
  assert.deepEqual(over.json.purchases, [], "the refusal says nothing was bought");
  assert.equal(chats(), 3, "the refused message never reached the model");
  assert.equal((await call("POST", "/api/chat", { token: AGENT_TOKEN, body: chat(100), ip: "198.51.100.1" })).status, 200, "other clients are unaffected");
});

test("chat cost abuse: a total cap applies across all clients", async () => {
  const { call } = await start({ clientIpHeader: "x-real-ip", limits: { chatTotal: { limit: 4, windowMs: 60_000 } } });
  for (let n = 0; n < 4; n++) assert.equal((await call("POST", "/api/chat", { token: AGENT_TOKEN, body: chat(n), ip: `192.0.2.${n}` })).status, 200);
  assert.equal((await call("POST", "/api/chat", { token: AGENT_TOKEN, body: chat(9), ip: "192.0.2.50" })).status, 429);
});

test("voice cost abuse: minting voice sessions is rate-limited per client", async () => {
  const { call } = await start({ clientIpHeader: "x-real-ip", limits: { voicePerClient: { limit: 2, windowMs: 60_000 } } });
  for (let i = 0; i < 2; i++) assert.equal((await call("POST", "/api/voice/session", { token: AGENT_TOKEN, body: {}, ip: "203.0.113.5" })).status, 200);
  assert.equal((await call("POST", "/api/voice/session", { token: AGENT_TOKEN, body: {}, ip: "203.0.113.5" })).status, 429);
  assert.equal((await call("POST", "/api/voice/session", { token: AGENT_TOKEN, body: {}, ip: "198.51.100.1" })).status, 200);
});

test("rate limits don't apply before auth: an unauthenticated flood can't use up a client's budget", async () => {
  const { call } = await start({ clientIpHeader: "x-real-ip", limits: { chatPerClient: { limit: 2, windowMs: 60_000 } } });
  for (let n = 0; n < 5; n++) assert.equal((await call("POST", "/api/chat", { body: chat(n), ip: "203.0.113.5" })).status, 401);
  assert.equal((await call("POST", "/api/chat", { token: AGENT_TOKEN, body: chat(50), ip: "203.0.113.5" })).status, 200);
});

test("clientAddress: the proxy's value (last) wins; without a trusted header the socket address is used", () => {
  const req = (headers: Record<string, string | string[]>) =>
    ({ headers, socket: { remoteAddress: "10.0.0.1" } }) as unknown as Parameters<typeof clientAddress>[0];
  assert.equal(clientAddress(req({ "x-real-ip": "198.51.100.7" }), "x-real-ip"), "198.51.100.7");
  assert.equal(clientAddress(req({ "x-real-ip": "6.6.6.6, 198.51.100.7" }), "x-real-ip"), "198.51.100.7", "a client-sent value in front is ignored");
  assert.equal(clientAddress(req({ "x-real-ip": "6.6.6.6" })), "10.0.0.1", "untrusted header ignored");
  assert.equal(clientAddress(req({}), "x-real-ip"), "10.0.0.1", "missing header falls back to the socket");
});

test("parseLimit: whole numbers from 1 to max, with the old fallbacks", () => {
  assert.equal(parseLimit(null, 20, 100), 20);
  assert.equal(parseLimit("abc", 20, 100), 20);
  assert.equal(parseLimit("0", 20, 100), 20);
  assert.equal(parseLimit("1.5", 20, 100), 1);
  assert.equal(parseLimit("-3", 20, 100), 1);
  assert.equal(parseLimit("99999999", 20, 100), 100);
  assert.equal(parseLimit("Infinity", 20, 100), 100);
  assert.equal(parseLimit("50", 20, 100), 50);
});

test("an Arc RPC outage doesn't break /api/budget: limits and spending still load, the balance shows as unknown", async () => {
  // What production logged on 2026-11-26 when the SDK's default RPC host stopped resolving.
  const { call } = await start({ gatewayAvailable: async () => { throw new Error("ContractFunctionExecutionError: HTTP request failed."); } });
  const r = await call("GET", "/api/budget", { token: AGENT_TOKEN });
  assert.equal(r.status, 200);
  assert.equal(r.json.dailyCapUsdc, "5");
  assert.equal(r.json.remainingTodayUsdc, "5");
  assert.equal(r.json.availableFundsUsdc, null, "balance unknown, not a 500");
});

test("every JSON response carries security headers (200, 401 and 404 responses)", async () => {
  const { call } = await start();
  for (const [method, path] of [["GET", "/health"], ["GET", "/api/budget"], ["GET", "/no/such/route"]] as const) {
    const { headers } = await call(method, path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", `${path}: nosniff`);
    assert.equal(headers.get("x-frame-options"), "DENY", `${path}: x-frame-options`);
    assert.match(headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/, `${path}: csp`);
    assert.match(headers.get("strict-transport-security") ?? "", /max-age=\d{7,}/, `${path}: hsts`);
    assert.equal(headers.get("referrer-policy"), "no-referrer", `${path}: referrer-policy`);
  }
});
