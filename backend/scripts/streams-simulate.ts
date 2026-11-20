/**
 * Simulates Quicknode Streams deliveries to the RUNNING service. Real parts: the rendered filter and
 * real Arc Testnet logs (streams/fixtures). Simulated part: the transport, i.e. we sign with
 * QN_STREAM_SECURITY_TOKEN exactly as Quicknode documents, instead of Quicknode sending it.
 *   npm run streams:simulate                 # real movements: expect 3 stored, no freeze
 *   npm run streams:simulate -- --anomaly    # also a synthetic outbound transfer: expect freeze, then operator unfreeze
 * Prints no secrets.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, optionalEnv, privateKeyFromEnv, tokenFromEnv } from "../src/config.ts";
import { renderFilter, runFilter } from "../src/streams-filter.ts";
import { signQuickNode } from "../src/streams.ts";

const base = optionalEnv("SIMULATE_BASE_URL", `http://127.0.0.1:${optionalEnv("PORT", "8787")}`).replace(/\/$/, "");
const token = tokenFromEnv("QN_STREAM_SECURITY_TOKEN");
const agentToken = tokenFromEnv("AGENT_API_TOKEN");
const operatorToken = tokenFromEnv("OPERATOR_API_TOKEN");
const agent = privateKeyToAccount(privateKeyFromEnv("BUYER_PRIVATE_KEY")).address.toLowerCase();
const failures: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function deliver(body: unknown, o: { nonce?: string; tamper?: boolean } = {}) {
  const payload = JSON.stringify(body);
  const nonce = o.nonce ?? randomBytes(16).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signQuickNode(token, nonce, ts, payload);
  const res = await fetch(`${base}/webhooks/quicknode`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": sig },
    body: o.tamper ? payload.replace(/"amount_raw":"(\d)/, '"amount_raw":"9$1') : payload,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any>, nonce };
}
const api = async (method: string, path: string, bearer: string) =>
  (await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${bearer}` } })).json() as Promise<Record<string, any>>;

const fixture = JSON.parse(readFileSync(new URL("../streams/fixtures/arc-testnet-receipt-logs.json", import.meta.url), "utf8"));
const body = runFilter(renderFilter(ARC_TESTNET.chainId, [agent]), {
  data: fixture.logs,
  metadata: { network: "arc-testnet", batch_start_range: 73167868, batch_end_range: 73173107 },
}) as { movements: unknown[] } | null;
check(body !== null && body.movements.length === 3, "filter on real Arc Testnet logs", `${body?.movements.length ?? 0} movements`);

const tampered = await deliver(body, { tamper: true });
check(tampered.status === 401, "tampered delivery refused", `HTTP ${tampered.status}`);
const first = await deliver(body);
check(first.status === 200 && first.json.frozen === false, "signed delivery accepted", `received ${first.json.received}, new ${first.json.inserted}`);
const replay = await deliver(body, { nonce: first.nonce });
check(replay.json.duplicate === true, "replayed nonce acknowledged, not reprocessed");

if (process.argv.includes("--anomaly")) {
  const tx = `0x${randomBytes(32).toString("hex")}`;
  const r = await deliver({
    movements: [{
      canonical_id: `${ARC_TESTNET.chainId}:${tx}:0`, block_number: "1", transaction_hash: tx, log_index: "0",
      from_address: agent, to_address: `0x${"9".repeat(40)}`, amount_raw: "1000000000000000000", decimals: 18,
    }],
  });
  check(r.json.frozen === true, "SYNTHETIC unexpected outbound transfer froze spending");
  const b = await api("GET", "/api/budget", agentToken);
  check(b.frozen === true, "budget reports frozen", b.frozenReason);
  await api("POST", "/api/policy/unfreeze", operatorToken);
  check((await api("GET", "/api/budget", agentToken)).frozen === false, "operator unfroze it");
}

const list = await api("GET", "/api/chain/movements?limit=10", agentToken);
for (const m of list.movements ?? []) console.log(`  ${m.classification.padEnd(20)} ${m.amountUsdc.padStart(6)} USDC  block ${m.block}  ${m.txHash.slice(0, 14)}…`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
