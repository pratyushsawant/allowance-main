/**
 * Offline end-to-end tests of policy + ledger + buyer + reconciler against a fake x402
 * seller (real PAYMENT-REQUIRED offers, real guarded signatures from a throwaway key).
 * No Gateway, no chain: the fake seller "accepts" without settling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createBuyer } from "./buyer.ts";
import { ARC_TESTNET } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createLedger, type Ledger } from "./ledger.ts";
import type { PolicyConfig } from "./policy.ts";
import { createReconciler, type GatewayTransfer } from "./reconciler.ts";
import { decodeHeader, encodeHeader } from "./x402.ts";

const payer = privateKeyToAccount(generatePrivateKey());
const SELLER = privateKeyToAccount(generatePrivateKey()).address;
const UNLISTED = privateKeyToAccount(generatePrivateKey()).address;

type Mode = "ok" | "hang" | `reject:${string}`;
interface FakeSeller {
  base: string;
  paid: number;
  nonces: string[];
  set(o: { payTo?: string; amount?: string; mode?: Mode }): void;
  close(): Promise<void>;
}

async function fakeSeller(init: { payTo: string; amount: string; mode?: Mode }): Promise<FakeSeller> {
  let cfg = { mode: "ok" as Mode, ...init };
  const state = { paid: 0, nonces: [] as string[] };
  const server: Server = createServer((req, res) => {
    const resourceUrl = `${base}${req.url}`;
    const sig = req.headers["payment-signature"];
    if (typeof sig !== "string") {
      const offer = {
        x402Version: 2,
        resource: { url: resourceUrl, description: "test", mimeType: "application/json" },
        accepts: [{
          scheme: "exact", network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, amount: cfg.amount,
          payTo: cfg.payTo, maxTimeoutSeconds: 604_900,
          extra: { name: "GatewayWalletBatched", version: "2", verifyingContract: ARC_TESTNET.gatewayWallet },
        }],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": encodeHeader(offer) }).end("{}");
      return;
    }
    state.paid++;
    state.nonces.push(decodeHeader<{ payload: { authorization: { nonce: string } } }>(sig).payload.authorization.nonce);
    if (cfg.mode === "hang") return; // never answers
    if (cfg.mode.startsWith("reject:")) {
      res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: cfg.mode.slice(7) }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: { item: req.url }, payment: { transaction: randomUUID() } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    get paid() { return state.paid; },
    get nonces() { return state.nonces; },
    set(o) { cfg = { ...cfg, ...o }; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function setup(over: Partial<PolicyConfig> = {}, available = 5_000_000n) {
  const config: PolicyConfig = {
    network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, decimals: 6, allowedPayees: [SELLER],
    autoApproveMax: 250_000n, perCallMax: 1_000_000n, dailyCap: 2_000_000n, timeZone: "America/Chicago", ...over,
  };
  const db = openDatabase(":memory:");
  const ledger = createLedger(db, config);
  const buyer = createBuyer({ ledger, account: payer, gatewayAvailable: async () => available, paidRequestTimeoutMs: 300 });
  return { db, ledger, buyer };
}

const req = (seller: FakeSeller, path = "/r", key: string = randomUUID()) =>
  ({ idempotencyKey: key, itemId: "item", sellerId: "s", resourceUrl: `${seller.base}${path}` });
const committed = (ledger: Ledger) => ledger.budget().committedToday;

test("auto-approved purchase is signed once, sent, and accepted", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "5000" });
  const { ledger, buyer } = setup();
  const p = await buyer.purchase(req(seller));
  assert.equal(p.state, "accepted");
  assert.equal(seller.paid, 1);
  assert.equal(p.nonce, seller.nonces[0]);
  assert.ok(p.gatewayTransferId);
  assert.equal(committed(ledger), 5000n);
  await seller.close();
});

test("over-threshold purchase waits for a person; nothing is signed until approved", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "750000" });
  const { ledger, buyer } = setup();
  const p = await buyer.purchase(req(seller));
  assert.equal(p.state, "awaiting_approval");
  assert.equal(seller.paid, 0);
  assert.equal(committed(ledger), 0n, "awaiting approval holds no budget");
  const approved = await buyer.approve(p.id);
  assert.equal(approved.state, "accepted");
  assert.equal(seller.paid, 1);
  await assert.rejects(buyer.approve(p.id), /not awaiting approval/); // cannot approve twice
  await seller.close();
});

test("unlisted payee and frozen state are blocked without signing", async () => {
  const unlisted = await fakeSeller({ payTo: UNLISTED, amount: "10000" });
  const { ledger, buyer } = setup();
  const b = await buyer.purchase(req(unlisted));
  assert.equal(b.state, "blocked");
  assert.match(b.reason!, /not on the allowlist/);
  const listed = await fakeSeller({ payTo: SELLER, amount: "5000" });
  ledger.setFrozen(true, "test freeze");
  const f = await buyer.purchase(req(listed));
  assert.equal(f.state, "blocked");
  assert.match(f.reason!, /frozen/);
  assert.equal(unlisted.paid + listed.paid, 0);
  await unlisted.close();
  await listed.close();
});

test("concurrent purchases never exceed the daily cap", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "250000" }); // $0.25 each, cap $2.00
  const { ledger, buyer } = setup();
  const results = await Promise.all(Array.from({ length: 10 }, () => buyer.purchase(req(seller))));
  const states = results.map((r) => r.state).sort();
  assert.equal(states.filter((s) => s === "accepted").length, 8);
  assert.equal(states.filter((s) => s === "blocked").length, 2);
  assert.equal(seller.paid, 8);
  assert.equal(committed(ledger), 2_000_000n);
  await seller.close();
});

test("the same idempotency key pays at most once, even concurrently", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "5000" });
  const { buyer } = setup();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => buyer.purchase(req(seller, "/r", key))));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(seller.paid, 1);
  const again = await buyer.purchase(req(seller, "/r", key));
  assert.equal(again.id, results[0].id);
  assert.equal(seller.paid, 1);
  await seller.close();
});

test("a seller that hangs leaves the payment pending, held, until Gateway or expiry decides", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "20000", mode: "hang" });
  const { ledger, buyer } = setup();
  const p = await buyer.purchase(req(seller));
  assert.equal(p.state, "pending_unknown");
  assert.equal(committed(ledger), 20_000n, "a timeout does not release funds");

  let found: GatewayTransfer | undefined;
  let clock = Date.now();
  const rec = createReconciler(ledger, {
    findByNonce: async () => found,
    getTransferById: async (id) => ({ id, status: "received", txHash: null }),
  }, { now: () => clock, log: () => {} });

  await rec.reconcileOnce();
  assert.equal(ledger.get(p.id)!.state, "pending_unknown", "unseen but still valid: keep holding");

  clock = (p.validBefore! + 3600) * 1000; // after validBefore + margin
  await rec.reconcileOnce();
  assert.equal(ledger.get(p.id)!.state, "expired");
  assert.equal(committed(ledger), 0n, "released only after the authorization can no longer settle");

  // A second pending payment that Gateway did receive becomes accepted, not expired.
  const p2 = await buyer.purchase(req(seller));
  found = { id: randomUUID(), status: "batched", txHash: null };
  await rec.reconcileOnce();
  assert.equal(ledger.get(p2.id)!.state, "accepted");
  await seller.close();
});

test("permanent Gateway rejections release; other refusals stay pending", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "5000", mode: "reject:invalid_signature" });
  const { ledger, buyer } = setup();
  const a = await buyer.purchase(req(seller));
  assert.equal(a.state, "rejected");
  seller.set({ mode: "reject:insufficient_balance" }); // could still settle later if funds arrive
  const b = await buyer.purchase(req(seller));
  assert.equal(b.state, "pending_unknown");
  assert.equal(committed(ledger), 5000n);
  await seller.close();
});

test("if the seller's price changes between approval and payment, nothing is signed", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "750000" });
  const { ledger, buyer } = setup();
  const p = await buyer.purchase(req(seller));
  seller.set({ amount: "900000" });
  const after = await buyer.approve(p.id);
  assert.equal(after.state, "aborted");
  assert.match(after.reason!, /terms changed/);
  assert.equal(seller.paid, 0);
  assert.equal(committed(ledger), 0n);
  await seller.close();
});

test("reconciler settles accepted payments and cleans up interrupted ones", async () => {
  const seller = await fakeSeller({ payTo: SELLER, amount: "5000" });
  const { ledger, buyer } = setup();
  const p = await buyer.purchase(req(seller));
  let clock = Date.now();
  const rec = createReconciler(ledger, {
    findByNonce: async () => undefined,
    getTransferById: async (id) => ({ id, status: "completed", txHash: "0xabc" }),
  }, { now: () => clock, log: () => {} });
  await rec.reconcileOnce();
  const settled = ledger.get(p.id)!;
  assert.equal(settled.state, "settled");
  assert.equal(settled.settlementTx, "0xabc");

  // Simulate a crash right after reserving: a stale reservation is released, never signed.
  const { purchase } = ledger.reserve({ ...req(seller), quote: { payTo: SELLER, network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, amount: 5000n }, gatewayAvailable: 5_000_000n });
  clock += 5 * 60_000;
  await rec.reconcileOnce();
  assert.equal(ledger.get(purchase.id)!.state, "aborted");
  await seller.close();
});
