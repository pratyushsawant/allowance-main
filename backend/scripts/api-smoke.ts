/**
 * End-to-end check of the running service (npm start) on Arc Testnet. Spends real testnet USDC:
 * $0.005 + $0.02 + $0.75 (after operator approval). Prints identifiers only, never tokens.
 *   npm run api:smoke [-- <search words>]
 */
import { randomUUID } from "node:crypto";
import { optionalEnv, tokenFromEnv } from "../src/config.ts";

const base = optionalEnv("PUBLIC_BASE_URL", `http://${optionalEnv("HOST", "127.0.0.1")}:${optionalEnv("PORT", "8787")}`).replace(/\/$/, "");
const agent = tokenFromEnv("AGENT_API_TOKEN");
const operator = tokenFromEnv("OPERATOR_API_TOKEN");
const query = process.argv.slice(2).join(" ") || "vs";
const failures: string[] = [];

type Json = Record<string, any>;
async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}
function show(label: string, r: { status: number; json: Json }): void {
  const j = r.json;
  const parts = [`HTTP ${r.status}`, j.state ?? j.error ?? "", j.priceUsdc ? `$${j.priceUsdc}` : "", j.reason ?? j.message ?? ""];
  if (j.gatewayTransferId) parts.push(`transfer ${j.gatewayTransferId}`);
  console.log(`${label.padEnd(40)} ${parts.filter(Boolean).join(" | ")}`);
}
function expect(ok: boolean, what: string): void {
  if (!ok) failures.push(what);
}
const buy = (item: string, ticker: string, key = randomUUID()) => call("POST", "/api/purchases", agent, { item, ticker, idempotencyKey: key });

const search = await call("GET", `/api/markets/search?q=${encodeURIComponent(query)}`, agent);
const event = (search.json.results ?? []).find((e: Json) => e.contracts?.some((c: Json) => c.bestBid));
if (!event) {
  console.error(`No recorded event matching "${query}" with prices yet. Is the recorder running?`);
  process.exit(1);
}
console.log(`event ${event.ticker}: ${event.title}\n`);
const t = event.ticker as string;

const before = await call("GET", "/api/budget", agent);
console.log(`budget before: committed $${before.json.committedTodayUsdc} of $${before.json.dailyCapUsdc}, available $${before.json.availableFundsUsdc}\n`);

const key = randomUUID();
const snap = await buy("odds_snapshot", t, key);
show("1. snapshot $0.005 (auto)", snap);
expect(snap.json.state === "accepted", "snapshot should be accepted");
expect(Array.isArray(snap.json.result?.event?.contracts), "snapshot result should carry contracts");

const again = await buy("odds_snapshot", t, key);
show("2. same idempotency key again", again);
expect(again.json.id === snap.json.id && again.json.nonce === snap.json.nonce, "repeat key must return the same purchase");

const hist = await buy("odds_history", t);
show("3. history $0.02 (auto)", hist);
expect(hist.json.state === "accepted", "history should be accepted");

const brief = await buy("deep_brief", t);
show("4. deep brief $0.75", brief);
expect(brief.json.state === "awaiting_approval" && !brief.json.nonce, "brief should wait for approval, unsigned");

const agentApprove = await call("POST", `/api/purchases/${brief.json.id}/approve`, agent);
show("5. agent token tries to approve", agentApprove);
expect(agentApprove.status === 401, "agent token must not approve");

const approved = await call("POST", `/api/purchases/${brief.json.id}/approve`, operator);
show("6. operator approves", approved);
expect(approved.json.state === "accepted", "approved brief should be accepted");

const shady = await buy("full_report", t);
show("7. unlisted seller $0.01", shady);
expect(shady.json.state === "blocked" && !shady.json.nonce, "unlisted seller must be blocked, unsigned");

await call("POST", "/api/policy/freeze", operator, { reason: "api smoke test" });
const frozen = await buy("odds_snapshot", t);
show("8. snapshot while frozen", frozen);
expect(frozen.json.state === "blocked", "frozen purchase must be blocked");
const agentUnfreeze = await call("POST", "/api/policy/unfreeze", agent);
expect(agentUnfreeze.status === 401, "agent token must not unfreeze");
await call("POST", "/api/policy/unfreeze", operator);

const after = await call("GET", "/api/budget", agent);
console.log(`\nbudget after: committed $${after.json.committedTodayUsdc} of $${after.json.dailyCapUsdc}, available $${after.json.availableFundsUsdc}, frozen ${after.json.frozen}`);

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\n✓ all checks passed");
