/**
 * Drives the running service the way a browser frontend would: CORS, access-code login,
 * scoped sessions, voice-session minting, a paid tool call and the approval guard.
 * Spends $0.005 of testnet USDC (one snapshot). Never prints tokens or codes.
 *   npm run voice:smoke
 */
import { randomUUID } from "node:crypto";
import { optionalEnv, requireEnv } from "../src/config.ts";

requireEnv(["DEMO_ACCESS_CODE", "OPERATOR_ACCESS_CODE"]);
const base = optionalEnv("PUBLIC_BASE_URL", `http://${optionalEnv("HOST", "127.0.0.1")}:${optionalEnv("PORT", "8787")}`).replace(/\/$/, "");
const origin = optionalEnv("SMOKE_ORIGIN", "http://localhost:5173");
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

type Json = Record<string, any>;
async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

const pre = await fetch(`${base}/api/purchases`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
check(pre.status === 204 && pre.headers.get("access-control-allow-origin") === origin, `CORS preflight from ${origin}`, `HTTP ${pre.status}`);
const bad = await fetch(`${base}/api/purchases`, { method: "OPTIONS", headers: { origin: "https://not-allowed.example", "access-control-request-method": "POST" } });
check(bad.status === 403, "CORS preflight from an unlisted origin is refused", `HTTP ${bad.status}`);

check((await call("POST", "/api/sessions", undefined, { scope: "agent", accessCode: "definitely-wrong" })).status === 401, "wrong access code refused");
const agent = (await call("POST", "/api/sessions", undefined, { scope: "agent", accessCode: process.env.DEMO_ACCESS_CODE })).json;
check(typeof agent.token === "string", "agent session issued", `expires ${new Date(agent.expiresAt).toISOString()}`);
const operator = (await call("POST", "/api/sessions", undefined, { scope: "operator", accessCode: process.env.OPERATOR_ACCESS_CODE })).json;
check(typeof operator.token === "string", "operator session issued", `expires ${new Date(operator.expiresAt).toISOString()}`);

const voice = await call("POST", "/api/voice/session", agent.token, {});
if (voice.status === 200) {
  check(typeof voice.json.conversationToken === "string", "voice session minted via ElevenLabs", `token length ${voice.json.conversationToken.length}`);
} else {
  check(voice.status === 503, "voice session endpoint answers (not configured)", `HTTP ${voice.status} ${voice.json.error}; missing: ${(voice.json.missing ?? []).join(", ")}`);
}

const search = await call("GET", `/api/markets/search?q=${encodeURIComponent(optionalEnv("SMOKE_QUERY", "vs"))}`, agent.token);
const ticker = (search.json.results ?? []).find((e: Json) => e.contracts?.some((c: Json) => c.bestBid))?.ticker;
check(Boolean(ticker), "search_markets with agent session", ticker ?? "no event found");

const snap = await call("POST", "/api/purchases", agent.token, { item: "odds_snapshot", ticker, idempotencyKey: randomUUID() });
check(snap.json.state === "accepted", "buy odds_snapshot ($0.005) with agent session", snap.json.summary ?? snap.json.reason ?? `HTTP ${snap.status}`);

const brief = await call("POST", "/api/purchases", agent.token, { item: "deep_brief", ticker, idempotencyKey: randomUUID() });
check(brief.json.state === "awaiting_approval" && !brief.json.nonce, "deep_brief held for approval, unsigned", brief.json.next);
check((await call("POST", `/api/purchases/${brief.json.id}/approve`, agent.token)).status === 401, "agent session cannot approve");
const declined = await call("POST", `/api/purchases/${brief.json.id}/decline`, operator.token);
check(declined.json.state === "declined", "operator session declines it (nothing paid)");

const got = await call("GET", `/api/purchases/${snap.json.id}`, agent.token);
check(got.json.id === snap.json.id && typeof got.json.summary === "string", "get_purchase returns the spoken summary");
const budget = await call("GET", "/api/budget", agent.token);
check(budget.status === 200, "check_budget", `committed $${budget.json.committedTodayUsdc} of $${budget.json.dailyCapUsdc}, available $${budget.json.availableFundsUsdc}`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
