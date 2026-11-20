/**
 * Phase 2: sessions, scoped auth, CORS, voice-session minting and spoken summaries, exercised
 * through the real router/API over HTTP with an in-memory ledger and a stubbed ElevenLabs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerApi } from "./api.ts";
import { createAuth } from "./auth.ts";
import type { Buyer } from "./buyer.ts";
import { ARC_TESTNET } from "./config.ts";
import { createCors } from "./cors.ts";
import { openDatabase } from "./db.ts";
import { createRouter } from "./http.ts";
import { createLedger, type Purchase } from "./ledger.ts";
import { createMarketData } from "./market-data.ts";
import type { PolicyConfig } from "./policy.ts";
import { createRecorder } from "./recorder.ts";
import { createSessionSigner } from "./session.ts";
import { impliedPercent, spokenSummary } from "./summary.ts";
import { createVoiceSessions } from "./voice.ts";

const SELLER = "0x3b53b70d0275e5b2f8a3DFe6Cb0d949B3D7Ea14e";
const AGENT_TOKEN = "a".repeat(64);
const OPERATOR_TOKEN = "o".repeat(64);
const SECRET = "s".repeat(64);
const CODES = { agent: "agent-code-123", operator: "operator-code-456" };
const ALLOWED_ORIGIN = "http://localhost:5173";
const ELEVEN_KEY = "xi-test-key-not-real";

let server: Server;
let base = "";
const elevenCalls: Array<{ url: string; key: string | null }> = [];
let elevenStatus = 200;

before(async () => {
  const db = openDatabase(":memory:");
  await createRecorder(db, {
    fetchPage: async (offset, limit) => ({
      data: offset ? [] : [{
        id: "1", ticker: "EVT-1", title: "Team A vs Team B", category: "Sports",
        contracts: [
          { id: "1-a", label: "Team A", instrumentSymbol: "GEMI-EVT-1-A", prices: { bestBid: "0.51", bestAsk: "0.52" } },
          { id: "1-b", label: "Team B", instrumentSymbol: "GEMI-EVT-1-B", prices: { bestBid: "0.48", bestAsk: "0.49" } },
        ],
      }],
      pagination: { limit, offset, total: 1 },
    }),
    pageDelayMs: 0, log: () => {},
  }).pollOnce();

  const policy: PolicyConfig = {
    network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, decimals: 6, allowedPayees: [SELLER],
    autoApproveMax: 250_000n, perCallMax: 1_000_000n, dailyCap: 2_000_000n, timeZone: "America/Chicago",
  };
  const ledger = createLedger(db, policy);
  const quote = (amount: bigint) => ({ payTo: SELLER, network: policy.network, asset: policy.asset, amount });
  const buyer = {
    purchase: async (r: { idempotencyKey: string; itemId: string; sellerId: string; resourceUrl: string }) =>
      ledger.reserve({ ...r, quote: quote(r.itemId === "deep_brief" ? 750_000n : 5_000n), gatewayAvailable: 5_000_000n }).purchase,
    approve: async (id: string) => ledger.approve(id, 5_000_000n),
  } as unknown as Buyer;
  const sessions = createSessionSigner(SECRET);
  const voice = createVoiceSessions({
    apiKey: ELEVEN_KEY, agentId: "agent_test123",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      elevenCalls.push({ url: String(url), key: new Headers(init?.headers).get("xi-api-key") });
      const body = String(url).includes("/token") ? { token: "webrtc-token", conversation_id: "conv_1" } : { signed_url: "wss://example/signed" };
      return new Response(JSON.stringify(elevenStatus === 200 ? body : { detail: "bad key" }), { status: elevenStatus });
    }) as typeof fetch,
  });

  const router = createRouter(() => {});
  registerApi(router, {
    ledger, buyer, market: createMarketData(db), policy, publicBaseUrl: "http://127.0.0.1:1",
    auth: createAuth({ agentToken: AGENT_TOKEN, operatorToken: OPERATOR_TOKEN, sessions }),
    sessions, accessCodes: CODES, sessionTtlSeconds: { agent: 60, operator: 60 }, voice,
    gatewayAvailable: async () => 5_000_000n,
  });
  router.add("GET", "/sellers/x", ({ res }) => void res.writeHead(200).end("{}"));
  const cors = createCors([ALLOWED_ORIGIN]);
  server = createServer((req, res) => {
    if (cors(req, res)) return;
    void router.handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, opts: { token?: string; body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.origin) headers.origin = opts.origin;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const login = async (scope: "agent" | "operator", accessCode: string) =>
  call("POST", "/api/sessions", { body: { scope, accessCode } });

test("access codes issue scoped sessions; wrong or cross-scope codes are refused", async () => {
  assert.equal((await login("agent", "nope")).status, 401);
  assert.equal((await login("operator", CODES.agent)).status, 401, "the agent code cannot open an operator session");
  const ok = await login("agent", CODES.agent);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.scope, "agent");
  assert.match(ok.json.token, /^as1\./);
  assert.ok(ok.json.expiresAt > Date.now());
});

test("an agent session can buy and read but never approve, decline or unfreeze", async () => {
  const agent = (await login("agent", CODES.agent)).json.token;
  assert.equal((await call("GET", "/api/budget", { token: agent })).status, 200);
  const held = await call("POST", "/api/purchases", { token: agent, body: { item: "deep_brief", ticker: "EVT-1", idempotencyKey: "voice-test-0001" } });
  assert.equal(held.json.state, "awaiting_approval");
  assert.equal((await call("POST", `/api/purchases/${held.json.id}/approve`, { token: agent })).status, 401);
  assert.equal((await call("POST", `/api/purchases/${held.json.id}/approve`, { token: AGENT_TOKEN })).status, 401);
  assert.equal((await call("POST", `/api/purchases/${held.json.id}/decline`, { token: agent })).status, 401);
  assert.equal((await call("POST", "/api/policy/unfreeze", { token: agent })).status, 401);

  const operator = (await login("operator", CODES.operator)).json.token;
  const approved = await call("POST", `/api/purchases/${held.json.id}/approve`, { token: operator });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.state, "reserved"); // stub buyer does not execute payment
  assert.equal((await call("GET", "/api/budget", { token: operator })).status, 200, "operator scope also covers agent routes");
});

test("expired and tampered session tokens are rejected", async () => {
  const past = createSessionSigner(SECRET, () => Date.now() - 3_600_000).issue("agent", 60).token;
  assert.equal((await call("GET", "/api/budget", { token: past })).status, 401);
  const good = (await login("agent", CODES.agent)).json.token as string;
  const [v, payload, sig] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), scope: "operator" })).toString("base64url");
  assert.equal((await call("POST", "/api/policy/unfreeze", { token: `${v}.${forged}.${sig}` })).status, 401);
  assert.equal(createSessionSigner("x".repeat(64)).verify(good), null, "another secret cannot verify it");
});

test("failed logins are rate limited", async () => {
  // Earlier tests used 2 failures from this address; the limit is 10 per 10 minutes,
  // so 8 more failures reach it and the next attempt is refused before the code is checked.
  let last = 0;
  for (let i = 0; i < 8; i++) last = (await login("agent", `wrong-${i}`)).status;
  assert.equal(last, 401);
  assert.equal((await login("agent", CODES.agent)).status, 429, "even the right code waits once the limit is hit");
});

test("CORS allows only listed origins, on API routes only", async () => {
  const pre = await fetch(`${base}/api/purchases`, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/);
  assert.equal(pre.headers.get("access-control-allow-credentials"), null);
  const bad = await fetch(`${base}/api/purchases`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const health = await call("GET", "/health", { origin: ALLOWED_ORIGIN });
  assert.equal(health.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  const seller = await fetch(`${base}/sellers/x`, { headers: { origin: ALLOWED_ORIGIN } });
  assert.equal(seller.headers.get("access-control-allow-origin"), null);
});

test("voice session is minted server-side with the key in a header, never returned", async () => {
  const agent = (await call("POST", "/api/voice/session", { token: AGENT_TOKEN, body: {} }));
  assert.equal(agent.status, 200);
  assert.deepEqual(agent.json, { transport: "webrtc", conversationToken: "webrtc-token", conversationId: "conv_1" });
  const ws = await call("POST", "/api/voice/session", { token: AGENT_TOKEN, body: { transport: "websocket" } });
  assert.equal(ws.json.signedUrl, "wss://example/signed");
  assert.match(elevenCalls[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/convai\/conversation\/token\?agent_id=agent_test123$/);
  assert.match(elevenCalls[1].url, /\/v1\/convai\/conversation\/get-signed-url\?agent_id=agent_test123$/);
  assert.ok(elevenCalls.every((c) => c.key === ELEVEN_KEY));
  assert.equal((await call("POST", "/api/voice/session", { body: {} })).status, 401, "needs agent access");

  elevenStatus = 401;
  const upstream = await call("POST", "/api/voice/session", { token: AGENT_TOKEN, body: {} });
  elevenStatus = 200;
  assert.equal(upstream.status, 502);
  assert.equal(JSON.stringify(upstream.json).includes(ELEVEN_KEY), false);
});

test("unconfigured voice reports which variables are missing", async () => {
  const v = createVoiceSessions({});
  assert.equal(v.configured, false);
  await assert.rejects(v.create("webrtc"), (e: Error & { missing?: string[] }) => {
    assert.deepEqual(e.missing, ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID"]);
    return true;
  });
});

test("spoken summaries use exact midpoints and say when nothing moved", () => {
  assert.equal(impliedPercent("0.51", "0.52"), "51.5%"); // exact; not rounded up to 52%
  assert.equal(impliedPercent("0.48", "0.49"), "48.5%"); // so the pair reads 100%, not 101%
  assert.equal(impliedPercent(null, "0.30"), "30%");
  assert.equal(impliedPercent(null, null), null);
  const base = { state: "accepted", itemId: "odds_snapshot" } as Purchase;
  const snap = spokenSummary({
    ...base,
    result: { event: { title: "Team A vs Team B", contracts: [{ label: "Team A", bestBid: "0.51", bestAsk: "0.52" }] } },
  });
  assert.equal(snap, "Team A vs Team B: Team A about 51.5%. These are implied probabilities from the bid/ask midpoint.");
  const since = Date.UTC(2026, 10, 20, 9, 49);
  const thin = spokenSummary({ ...base, itemId: "odds_history", result: { title: "T", recordedSince: since, biggestMovers: [], contracts: [{ points: [{ at: since }] }] } });
  assert.equal(thin, "T: not enough recorded history yet to describe movement since 3:49 AM.", "one point is not history");
  const flat = spokenSummary({ ...base, itemId: "odds_history", result: { title: "T", recordedSince: since, biggestMovers: [], contracts: [{ points: [{ at: since }, { at: since + 20 * 60_000 }] }] } });
  assert.equal(flat, "T: no price changes recorded since 3:49 AM.");
  const moved = spokenSummary({ ...base, itemId: "odds_history", result: { title: "T", biggestMovers: [{ label: "A", bidChange: "-0.025" }] } });
  assert.equal(moved, "T: A down 2.5 points.");
  assert.equal(spokenSummary({ ...base, state: "blocked" }), null);
});
