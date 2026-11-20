import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type PolicyConfig, type PolicyInputs, type Quote } from "./policy.ts";

const SELLER = "0x3b53b70d0275e5b2f8a3DFe6Cb0d949B3D7Ea14e";
const OTHER = "0x1111111111111111111111111111111111111111";
const USDC = "0x3600000000000000000000000000000000000000";

const config: PolicyConfig = {
  network: "eip155:5042002",
  asset: USDC,
  decimals: 6,
  allowedPayees: [SELLER],
  autoApproveMax: 250_000n, // $0.25
  perCallMax: 1_000_000n, // $1.00
  dailyCap: 2_000_000n, // $2.00
  timeZone: "America/Chicago",
};
const inputs = (o: Partial<PolicyInputs> = {}): PolicyInputs => ({
  frozen: false, frozenReason: null, committedToday: 0n, availableFunds: 5_000_000n, ...o,
});
const quote = (o: Partial<Quote> = {}): Quote => ({ payTo: SELLER, network: config.network, asset: USDC, amount: 5_000n, ...o });

test("brief's default catalog outcomes", () => {
  assert.equal(evaluate(quote({ amount: 5_000n }), inputs(), config).kind, "allow"); // $0.005 snapshot
  assert.equal(evaluate(quote({ amount: 20_000n }), inputs(), config).kind, "allow"); // $0.02 history
  assert.equal(evaluate(quote({ amount: 750_000n }), inputs(), config).kind, "needs_approval"); // $0.75 brief
  const unlisted = evaluate(quote({ payTo: OTHER, amount: 10_000n }), inputs(), config); // $0.01 unlisted report
  assert.equal(unlisted.kind === "deny" && unlisted.code, "payee_not_allowlisted");
});

test("each rule denies with its own code, in priority order", () => {
  const cases: Array<[string, Quote, PolicyInputs, string]> = [
    ["frozen beats everything", quote({ payTo: OTHER }), inputs({ frozen: true }), "frozen"],
    ["network", quote({ network: "eip155:1" }), inputs(), "wrong_network"],
    ["asset", quote({ asset: OTHER }), inputs(), "wrong_asset"],
    ["payee", quote({ payTo: OTHER }), inputs(), "payee_not_allowlisted"],
    ["zero amount", quote({ amount: 0n }), inputs(), "invalid_amount"],
    ["per-call cap", quote({ amount: 1_000_001n }), inputs(), "over_per_call_cap"],
    ["daily cap", quote({ amount: 20_000n }), inputs({ committedToday: 1_990_000n }), "over_daily_cap"],
    ["funds", quote({ amount: 20_000n }), inputs({ availableFunds: 19_999n }), "insufficient_funds"],
  ];
  for (const [label, q, s, code] of cases) {
    const d = evaluate(q, s, config);
    assert.equal(d.kind, "deny", label);
    assert.equal(d.kind === "deny" && d.code, code, label);
  }
});

test("boundaries are inclusive of the limit", () => {
  assert.equal(evaluate(quote({ amount: 250_000n }), inputs(), config).kind, "allow");
  assert.equal(evaluate(quote({ amount: 250_001n }), inputs(), config).kind, "needs_approval");
  assert.equal(evaluate(quote({ amount: 10_000n }), inputs({ committedToday: 1_990_000n }), config).kind, "allow");
  assert.equal(evaluate(quote({ amount: 1_000_000n }), inputs(), config, { humanApproved: true }).kind, "allow");
});

test("human approval lifts only the approval threshold, never a deny", () => {
  assert.equal(evaluate(quote({ amount: 750_000n }), inputs(), config, { humanApproved: true }).kind, "allow");
  assert.equal(evaluate(quote({ payTo: OTHER }), inputs(), config, { humanApproved: true }).kind, "deny");
  assert.equal(evaluate(quote({ amount: 750_000n }), inputs({ frozen: true }), config, { humanApproved: true }).kind, "deny");
  assert.equal(evaluate(quote({ amount: 750_000n }), inputs({ committedToday: 1_500_000n }), config, { humanApproved: true }).kind, "deny");
});

test("payee comparison ignores address checksum case", () => {
  assert.equal(evaluate(quote({ payTo: SELLER.toLowerCase() }), inputs(), config).kind, "allow");
});
