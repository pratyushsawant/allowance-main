/**
 * Streams filter on REAL Arc Testnet receipt logs (streams/fixtures), and the webhook receiver
 * over HTTP with signed deliveries. The only synthetic input is the "unexpected outbound" log,
 * which we deliberately never produced onchain.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createAuth } from "./auth.ts";
import { ARC_TESTNET } from "./config.ts";
import { openDatabase, type DB } from "./db.ts";
import { createRouter } from "./http.ts";
import { createLedger, type Ledger } from "./ledger.ts";
import { createSessionSigner } from "./session.ts";
import { renderFilter, runFilter } from "./streams-filter.ts";
import { classify, registerStreamsWebhook, signQuickNode } from "./streams.ts";

const BUYER = "0xe5edec99dcf041e022e7a843d00b37fb49d08fbd";
const FAUCET = "0x3c3380cdfb94dfeeaa41cad9f58254ae380d752d";
const GW = ARC_TESTNET.gatewayWallet.toLowerCase();
const TOKEN = "qn-test-security-token-0123456789abcdef";
const AGENT = "a".repeat(64);
const fixture = JSON.parse(readFileSync(new URL("../streams/fixtures/arc-testnet-receipt-logs.json", import.meta.url), "utf8"));
const filter = renderFilter(ARC_TESTNET.chainId, [BUYER]);
const stream = { data: fixture.logs, metadata: { network: "arc-testnet", batch_start_range: 73167868, batch_end_range: 73173107 } };
const watched = { agent: BUYER, gatewayWallet: GW, gatewayMinter: ARC_TESTNET.gatewayMinter };

type Payload = { movements: Array<Record<string, any>> };

test("verifier matches Quicknode's documented recipe (vector from the guide's Python code)", async () => {
  // Computed independently with: hmac.new(secret.encode(), (nonce + timestamp + payload).encode(), sha256).hexdigest()
  const { verifyQuickNodeSignature } = await import("./streams.ts");
  const secret = "qn-reference-vector-token-0123456789abcdef";
  const nonce = "02c6d2644296c8b830970891410825a3";
  const ts = "1735613672";
  const payload = '{"movements":[],"note":"café"}'; // non-ASCII: both sides must use UTF-8
  const expected = "65a1f63636c070568a37a93f111368cf1bb63551e48a777557162ca0fc6a757b";
  assert.equal(signQuickNode(secret, nonce, ts, payload), expected);
  assert.equal(verifyQuickNodeSignature(secret, nonce, ts, payload, expected), true);
  assert.equal(verifyQuickNodeSignature(secret, nonce, ts, payload, expected.toUpperCase()), true, "hex case-insensitive");
  assert.equal(verifyQuickNodeSignature(secret, nonce, ts, payload + " ", expected), false);
  assert.equal(verifyQuickNodeSignature(secret, nonce, ts, payload, `sha256=${expected}`), false, "no prefix in Quicknode's format");
  assert.equal(verifyQuickNodeSignature(secret, nonce, ts, payload, ""), false);
});

test("filter keeps only native-emitter Transfers touching the agent (real Arc Testnet logs)", () => {
  const out = runFilter(filter, stream) as Payload;
  assert.equal(fixture.logs.length, 8, "fixture: 3 native, 3 ERC-20 mirror, 2 Gateway events");
  assert.equal(out.movements.length, 3, "mirror (0x3600…) and Gateway events are excluded");
  const byTx = Object.fromEntries(out.movements.map((m) => [m.transaction_hash.slice(0, 10), m]));
  assert.deepEqual(
    [byTx["0xd9c7ff5a"].from_address, byTx["0xd9c7ff5a"].amount_raw],
    [FAUCET, "20000000000000000000"],
    "faucet top-up: 20 USDC at 18 decimals",
  );
  assert.equal(byTx["0x3e0c1e01"].canonical_id, `5042002:${byTx["0x3e0c1e01"].transaction_hash}:14`);
  assert.equal(byTx["0x754635df"].amount_raw, "2000000000000000000");
  assert.equal(runFilter(renderFilter(ARC_TESTNET.chainId, ["0x" + "1".repeat(40)]), stream), null, "nothing for unwatched wallets");
});

test("classification of the real movements and the anomaly rule", () => {
  const out = runFilter(filter, stream) as Payload;
  const classes = out.movements.map((m) => classify(m.from_address, m.to_address, watched)).sort();
  assert.deepEqual(classes, ["gateway_deposit", "gateway_deposit", "top_up"]);
  assert.equal(classify(BUYER, "0x" + "9".repeat(40), watched), "unexpected_outbound");
  assert.equal(classify("0x" + "0".repeat(40), BUYER, watched), "gateway_withdrawal");
  assert.equal(classify(FAUCET, GW, watched), "unrelated");
});

let server: Server;
let base = "";
let db: DB;
let ledger: Ledger;
let clock = Date.now();
before(async () => {
  db = openDatabase(":memory:");
  ledger = createLedger(db, {
    network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, decimals: 6, allowedPayees: [GW],
    autoApproveMax: 1n, perCallMax: 1n, dailyCap: 1n, timeZone: "America/Chicago",
  });
  const router = createRouter(() => {});
  registerStreamsWebhook(router, {
    db, ledger, ...watched, securityToken: TOKEN, chainId: ARC_TESTNET.chainId, usdcDecimals: 6,
    auth: createAuth({ agentToken: AGENT, operatorToken: "o".repeat(64), sessions: createSessionSigner("s".repeat(64)) }),
    now: () => clock,
  });
  server = createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function deliver(body: unknown, o: { nonce?: string; ts?: number; token?: string; gzip?: boolean; tamper?: boolean } = {}) {
  const payload = JSON.stringify(body);
  const nonce = o.nonce ?? crypto.randomUUID().replace(/-/g, "");
  const ts = String(o.ts ?? Math.floor(clock / 1000));
  const signature = signQuickNode(o.token ?? TOKEN, nonce, ts, payload);
  const sent = o.tamper ? payload.replace("20000000000000000000", "90000000000000000000") : payload;
  const res = await fetch(`${base}/webhooks/quicknode`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": signature,
      ...(o.gzip ? { "content-encoding": "gzip" } : {}),
    },
    body: o.gzip ? gzipSync(sent) : sent,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any>, nonce };
}
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM chain_movements").get() as { n: number }).n;
const frozen = () => ledger.budget().frozen;

test("unsigned, mis-signed, tampered and stale deliveries change nothing", async () => {
  const body = runFilter(filter, stream);
  const missing = await fetch(`${base}/webhooks/quicknode`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(missing.status, 401);
  assert.equal((await deliver(body, { token: "wrong-token-wrong-token-wrong-token!!" })).status, 401);
  assert.equal((await deliver(body, { tamper: true })).status, 401);
  assert.equal((await deliver(body, { ts: Math.floor(clock / 1000) - 3600 })).status, 401);
  assert.equal(count(), 0);
  assert.equal(frozen(), false);
});

test("a signed delivery of real movements is stored once, however often it arrives", async () => {
  const body = runFilter(filter, stream);
  const first = await deliver(body);
  assert.equal(first.status, 200);
  assert.deepEqual([first.json.received, first.json.inserted, first.json.frozen], [3, 3, false]);
  const replay = await deliver(body, { nonce: first.nonce });
  assert.equal(replay.json.duplicate, true, "same nonce: acknowledged, not reprocessed");
  const resent = await deliver(body, { gzip: true });
  assert.deepEqual([resent.status, resent.json.inserted], [200, 0], "new nonce, same logs: deduped by canonical id");
  assert.equal(count(), 3);
  const row = db.prepare("SELECT amount_usdc, classification FROM chain_movements WHERE from_address = ?").safeIntegers(true).get(FAUCET) as { amount_usdc: bigint; classification: string };
  assert.deepEqual([row.amount_usdc, row.classification], [20_000_000n, "top_up"], "18 -> 6 decimals, exact");
  assert.equal(frozen(), false, "top-ups and Gateway deposits never freeze");

  const list = await fetch(`${base}/api/chain/movements`, { headers: { authorization: `Bearer ${AGENT}` } });
  const movements = ((await list.json()) as { movements: Array<{ amountUsdc: string }> }).movements;
  assert.deepEqual(movements.map((m) => m.amountUsdc).sort(), ["1", "2", "20"]);
});

test("an outbound transfer the agent did not make freezes spending", async () => {
  const tx = "0x" + "ab".repeat(32);
  const anomaly = {
    movements: [{
      canonical_id: `5042002:${tx}:3`, chain_id: "5042002", block_number: "73200000", transaction_hash: tx, log_index: "3",
      from_address: BUYER, to_address: "0x" + "9".repeat(40), amount_raw: "1500000000000000001", decimals: 18,
    }],
  };
  const r = await deliver(anomaly);
  assert.deepEqual([r.status, r.json.frozen], [200, true]);
  const b = ledger.budget();
  assert.equal(b.frozen, true);
  assert.match(b.frozenReason!, /Unexpected outbound transfer of 1\.500000000000000001 USDC/);
  const row = db.prepare("SELECT amount_usdc FROM chain_movements WHERE tx_hash = ?").get(tx) as { amount_usdc: number | null };
  assert.equal(row.amount_usdc, null, "not exactly representable in 6 decimals: kept raw, never truncated");
});

test("filter also works on receipts-shaped Stream payloads (what the live Stream sent)", () => {
  // Same real logs, regrouped into receipts the way the live Stream delivered them: data:[[receipt{logs:[…]}]].
  const byTx = new Map<string, unknown[]>();
  for (const l of fixture.logs) byTx.set(l.transactionHash, [...(byTx.get(l.transactionHash) ?? []), l]);
  const receipts = [...byTx].map(([transactionHash, logs]) => ({ type: "0x2", status: "0x1", transactionHash, logs }));
  const out = runFilter(filter, { data: [receipts], metadata: { network: "arc-testnet" } }) as Payload;
  assert.deepEqual(out.movements.map((m) => m.canonical_id).sort(), (runFilter(filter, stream) as Payload).movements.map((m) => m.canonical_id).sort());
});

test("server-side raw-log rules match the Quicknode filter exactly (real Arc logs)", async () => {
  const { movementsFromRawLogs } = await import("./streams.ts");
  const viaFilter = (runFilter(filter, stream) as Payload).movements;
  const viaServer = movementsFromRawLogs(fixture.logs, ARC_TESTNET.chainId, [BUYER]);
  const key = (m: Record<string, any>) => [m.canonical_id, m.from_address, m.to_address, m.amount_raw, m.block_number].join("|");
  assert.deepEqual(viaServer.map(key).sort(), viaFilter.map(key).sort());
});

test("verified deliveries are parsed whatever the wrapper, and never silently dropped", async () => {
  const filtered = runFilter(filter, stream) as Payload;
  // Filter output wrapped the way Quicknode wraps stream payloads.
  const wrapped = await deliver({ data: [filtered], metadata: { network: "arc-testnet" } });
  assert.deepEqual([wrapped.status, wrapped.json.received, wrapped.json.inserted], [200, 3, 0], "found inside data[], deduped");
  // An unfiltered Stream: raw logs nested per block.
  const raw = await deliver({ data: [fixture.logs.slice(0, 3), fixture.logs.slice(3)], metadata: { network: "arc-testnet" } });
  assert.deepEqual([raw.status, raw.json.received, raw.json.inserted], [200, 3, 0], "raw logs -> same 3 movements, deduped");
  // A filter that returned null for a quiet batch.
  const empty = await deliver(null);
  assert.deepEqual([empty.status, empty.json.received], [200, 0]);
  assert.equal(count(), 4, "still exactly one row per real movement (+1 synthetic anomaly)");
});

test("movements for another chain id are ignored", async () => {
  const tx = "0x" + "cd".repeat(32);
  const r = await deliver({ movements: [{ canonical_id: `5042:${tx}:0`, block_number: "1", transaction_hash: tx, log_index: "0", from_address: BUYER, to_address: "0x" + "8".repeat(40), amount_raw: "1", decimals: 18 }] });
  assert.deepEqual([r.status, r.json.received, r.json.inserted], [200, 0, 0]);
});
