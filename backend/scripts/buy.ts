/**
 * Smoke-test buyer: pays the local seller once, binding the signature to the approved terms.
 *   npm run smoke:buy                                   # expects SMOKE_PRICE_USDC
 *   EXPECTED_PRICE_USDC=0.004 npm run smoke:buy         # negative test: must refuse, nothing signed
 *
 * Outcomes written to .smoke/payments.jsonl:
 *   refused          terms did not match; nothing signed
 *   signed           write-ahead record made BEFORE the signature leaves the process
 *   accepted         seller returned 2xx after Gateway accepted the authorization
 *   rejected         seller returned 402 with a Gateway error reason (not charged)
 *   pending_unknown  timeout / 5xx / network error. NOT treated as failure: the authorization
 *                    stays valid ~7 days and may still settle. Reconcile with smoke:status --nonce.
 */
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  MAX_AUTH_VALIDITY_SECONDS,
  MIN_AUTH_VALIDITY_SECONDS,
  addressFromEnv,
  optionalEnv,
  privateKeyFromEnv,
} from "../src/config.ts";
import { appendEvidence } from "../src/evidence.ts";
import { formatBaseUnits, toBaseUnits } from "../src/units.ts";
import {
  assertAuthorizationMatches,
  createGuardedSigner,
  decodeHeader,
  encodeHeader,
  selectApprovedOption,
  TermsMismatchError,
  type ApprovedTerms,
  type BatchPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "../src/x402.ts";
import { buyerClient, fail, verifiedUsdcDecimals } from "./shared.ts";

const PAID_REQUEST_TIMEOUT_MS = 45_000;

const client = buyerClient();
const account = privateKeyToAccount(privateKeyFromEnv("BUYER_PRIVATE_KEY"));
const decimals = await verifiedUsdcDecimals(client);
const resourceUrl =
  process.argv.slice(2).find((a) => a.startsWith("http")) ??
  `http://127.0.0.1:${optionalEnv("SELLER_PORT", "4021")}/smoke/premium`;
const expectedPrice = optionalEnv("EXPECTED_PRICE_USDC", optionalEnv("SMOKE_PRICE_USDC", "0.005"));

// In the full backend these come from the catalog entry the policy engine approved.
const terms: ApprovedTerms = {
  resourceUrl,
  network: ARC_TESTNET.network,
  chainId: ARC_TESTNET.chainId,
  asset: ARC_TESTNET.usdc.address,
  payTo: addressFromEnv("SELLER_ADDRESS"),
  amount: toBaseUnits(expectedPrice, decimals),
  verifyingContract: ARC_TESTNET.gatewayWallet,
  payer: account.address,
  allowedVersions: ["1", "2"],
  minValiditySeconds: MIN_AUTH_VALIDITY_SECONDS,
  maxValiditySeconds: MAX_AUTH_VALIDITY_SECONDS,
};
console.log(`approved terms: ${formatBaseUnits(terms.amount, decimals)} USDC (${terms.amount} base units, ${decimals} decimals) to ${terms.payTo}`);
console.log(`                resource ${resourceUrl}, network ${terms.network}, asset ${terms.asset}`);

// 1. Unpaid request -> 402 with the seller's terms.
const unpaid = await fetch(resourceUrl);
if (unpaid.status !== 402) fail(`Expected 402 from the seller, got ${unpaid.status}`);
const requiredHeader = unpaid.headers.get("payment-required") ?? fail("402 response has no PAYMENT-REQUIRED header");
const paymentRequired = decodeHeader<PaymentRequired>(requiredHeader);

// 2. The offer must match the approval exactly.
let option: PaymentRequirements;
try {
  option = selectApprovedOption(paymentRequired, terms);
} catch (err) {
  if (err instanceof TermsMismatchError) {
    appendEvidence("payments.jsonl", { phase: "refused", resourceUrl, mismatches: err.mismatches });
    fail(`REFUSED before signing. ${err.message}`, 3);
  }
  throw err;
}
console.log(`402 offer matches: amount ${option.amount}, payTo ${option.payTo}, auth version ${String(option.extra?.version)}`);

// 3. Funds check. (Phase 0 is one process making one request; the full backend reserves budget atomically first.)
const before = await client.getBalances();
console.log(`gateway available before: ${formatBaseUnits(before.gateway.available, decimals)} USDC`);
if (before.gateway.available < terms.amount) {
  fail(`Gateway available balance is below the price. Run \`npm run smoke:deposit -- --yes\` first. Nothing was signed.`, 4);
}

// 4. Sign exactly the approved authorization, once.
const scheme = new BatchEvmScheme(createGuardedSigner(account, terms, option));
const created = await scheme.createPaymentPayload(2, option);
const payload = created.payload as unknown as BatchPayload;
assertAuthorizationMatches(payload, terms);
const { nonce, validBefore } = payload.authorization;
appendEvidence("payments.jsonl", {
  phase: "signed",
  nonce,
  resourceUrl,
  payer: terms.payer,
  payTo: terms.payTo,
  asset: terms.asset,
  amount: terms.amount,
  authVersion: option.extra?.version,
  validBefore,
});
console.log(`signed authorization nonce ${nonce} (valid until ${new Date(Number(validBefore) * 1000).toISOString()})`);

// 5. Send it only to the approved resource.
let outcome: Record<string, unknown>;
try {
  const paid = await fetch(resourceUrl, {
    headers: {
      "PAYMENT-SIGNATURE": encodeHeader({
        x402Version: created.x402Version,
        payload,
        accepted: option,
        resource: paymentRequired.resource,
      }),
    },
    signal: AbortSignal.timeout(PAID_REQUEST_TIMEOUT_MS),
  });
  const body = (await paid.json().catch(() => ({}))) as {
    error?: string;
    data?: unknown;
    payment?: { transaction?: string };
  };
  const responseHeader = paid.headers.get("payment-response");
  const settle = responseHeader ? decodeHeader<{ transaction?: string }>(responseHeader) : undefined;
  if (paid.ok) {
    outcome = { status: "accepted", httpStatus: paid.status, transferId: body.payment?.transaction ?? settle?.transaction, data: body.data };
  } else if (paid.status === 402) {
    outcome = { status: "rejected", httpStatus: paid.status, reason: body.error };
  } else {
    outcome = { status: "pending_unknown", httpStatus: paid.status, reason: body.error ?? "unexpected status" };
  }
} catch (err) {
  const e = err as Error;
  outcome = { status: "pending_unknown", reason: e.name === "TimeoutError" ? "timeout" : e.message };
}
appendEvidence("payments.jsonl", { phase: "outcome", nonce, ...outcome });
console.log(`\noutcome: ${JSON.stringify(outcome)}`);

if (outcome.status === "accepted" && typeof outcome.transferId === "string") {
  try {
    const transfer = await client.getTransferById(outcome.transferId);
    console.log(`Gateway transfer ${transfer.id}: status ${transfer.status}, amount ${transfer.amount}, txHash ${transfer.txHash ?? "(none yet: batched settlement)"}`);
  } catch (err) {
    console.log(`getTransferById(${outcome.transferId}) failed: ${(err as Error).message}`);
  }
}
const after = await client.getBalances();
console.log(`gateway available after: ${formatBaseUnits(after.gateway.available, decimals)} USDC (delta ${formatBaseUnits(after.gateway.available - before.gateway.available, decimals)})`);
if (outcome.status === "pending_unknown") {
  console.log(`\nPayment outcome unknown. Keep the funds treated as spent and reconcile:\n  npm run smoke:status -- --nonce ${nonce}`);
  process.exit(5);
}
