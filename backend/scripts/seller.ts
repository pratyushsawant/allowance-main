/**
 * Framework-neutral x402 seller for the smoke test (plain node:http, 127.0.0.1 only).
 * Uses BatchFacilitatorClient — Circle's documented non-Express path — so the same
 * logic drops into Express or Next.js route handlers later.
 *
 * Before advertising a price it cross-checks the live Gateway /v1/x402/supported answer
 * against the SDK constants (Gateway Wallet, USDC address, decimals, auth version).
 * It settles against its OWN requirements, never the buyer-supplied `accepted` copy,
 * and never delivers when the settlement outcome is unknown.
 */
import { createServer, type ServerResponse } from "node:http";
import { CIRCLE_BATCHING_NAME, CIRCLE_BATCHING_SCHEME } from "@circle-fin/x402-batching";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { ARC_TESTNET, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS, addressFromEnv, gatewayApiUrl, optionalEnv } from "../src/config.ts";
import { appendEvidence } from "../src/evidence.ts";
import { toBaseUnits } from "../src/units.ts";
import { decodeHeader, encodeHeader, type BatchPayload, type PaymentRequired, type PaymentRequirements, type ResourceInfo } from "../src/x402.ts";
import { fail } from "./shared.ts";

const SETTLE_TIMEOUT_MS = 30_000;
const port = Number(optionalEnv("SELLER_PORT", "4021"));
const sellerAddress = addressFromEnv("SELLER_ADDRESS");
const version = optionalEnv("AUTH_VERSION", "2");
const resourceUrl = `http://127.0.0.1:${port}/smoke/premium`;
const facilitator = new BatchFacilitatorClient({ url: gatewayApiUrl() });

const supported = await facilitator.getSupported();
const kind = supported.kinds.find(
  (k) => k.network === ARC_TESTNET.network && k.scheme === CIRCLE_BATCHING_SCHEME && k.extra?.name === CIRCLE_BATCHING_NAME,
);
if (!kind) fail(`Gateway does not list ${CIRCLE_BATCHING_NAME} on ${ARC_TESTNET.network}`);
if (String(kind.extra?.verifyingContract).toLowerCase() !== ARC_TESTNET.gatewayWallet.toLowerCase()) {
  fail(`Live Gateway Wallet ${String(kind.extra?.verifyingContract)} != SDK ${ARC_TESTNET.gatewayWallet}`);
}
const liveAssets = (kind.extra?.assets ?? []) as Array<{ address: string; decimals: number; authorizationVersions?: string[] }>;
const liveUsdc = liveAssets.find((a) => a.address.toLowerCase() === ARC_TESTNET.usdc.address.toLowerCase());
if (!liveUsdc || liveUsdc.decimals !== ARC_TESTNET.usdc.decimals) fail("Live Gateway USDC entry missing or decimals differ from SDK config");
if (!liveUsdc.authorizationVersions?.includes(version)) fail(`Gateway does not accept authorization version ${version} for USDC`);
const minValidity = Number(kind.extra?.minValiditySeconds ?? 0);

const requirements: PaymentRequirements = {
  scheme: CIRCLE_BATCHING_SCHEME,
  network: ARC_TESTNET.network,
  asset: ARC_TESTNET.usdc.address,
  amount: toBaseUnits(optionalEnv("SMOKE_PRICE_USDC", "0.005"), ARC_TESTNET.usdc.decimals).toString(),
  payTo: sellerAddress,
  maxTimeoutSeconds: Math.max(GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS, minValidity),
  extra: { name: CIRCLE_BATCHING_NAME, version, verifyingContract: ARC_TESTNET.gatewayWallet },
};
const paymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: { url: resourceUrl, description: "Allowance Phase 0 smoke-test resource", mimeType: "application/json" },
  accepts: [requirements],
};

class SettleTimeout extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new SettleTimeout(`no answer in ${ms}ms`)), ms).unref()),
  ]);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

interface SignedPayment {
  x402Version: number;
  payload: BatchPayload;
  accepted?: Record<string, unknown>;
  resource?: ResourceInfo;
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", resourceUrl).pathname;
  if (req.method !== "GET" || path !== "/smoke/premium") return send(res, 404, { error: "not_found" });

  const header = req.headers["payment-signature"];
  if (typeof header !== "string") {
    console.log(`[seller] 402 -> ${requirements.amount} base units to ${sellerAddress}`);
    return send(res, 402, { error: "payment_required" }, { "PAYMENT-REQUIRED": encodeHeader(paymentRequired) });
  }

  let signed: SignedPayment;
  try {
    signed = decodeHeader<SignedPayment>(header);
  } catch {
    return send(res, 400, { error: "malformed_payment_signature" });
  }
  const nonce = signed.payload?.authorization?.nonce;
  if (signed.resource?.url !== resourceUrl) return send(res, 402, { error: "resource_mismatch", nonce });

  try {
    const settle = await withTimeout(facilitator.settle(signed as never, requirements), SETTLE_TIMEOUT_MS);
    appendEvidence("seller.jsonl", { event: "settle_result", nonce, ...settle });
    console.log(`[seller] settle success=${settle.success} transaction=${settle.transaction} ${settle.errorReason ?? ""}`);
    if (!settle.success) return send(res, 402, { error: settle.errorReason ?? "settlement_failed", nonce });
    return send(
      res,
      200,
      {
        data: { message: "Allowance Phase 0: paid resource delivered", servedAt: new Date().toISOString() },
        payment: { transaction: settle.transaction, payer: settle.payer, network: settle.network, amount: requirements.amount, nonce },
      },
      { "PAYMENT-RESPONSE": encodeHeader(settle) },
    );
  } catch (err) {
    const timedOut = err instanceof SettleTimeout;
    const message = String((err as Error).message).slice(0, 300);
    appendEvidence("seller.jsonl", { event: timedOut ? "settle_timeout" : "settle_error", nonce, message });
    console.log(`[seller] settlement outcome unknown (${message}); not delivering`);
    // Unknown outcome: the authorization may still settle. Do not deliver; the buyer must reconcile by nonce.
    return send(res, timedOut ? 504 : 502, { error: "settlement_status_unknown", nonce });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`[seller] ${resourceUrl}`);
  console.log(`[seller] price ${requirements.amount} base units (USDC decimals ${ARC_TESTNET.usdc.decimals}), payTo ${sellerAddress}, auth version ${version}, maxTimeoutSeconds ${requirements.maxTimeoutSeconds}`);
  console.log(`[seller] live Gateway: verifyingContract ${String(kind.extra?.verifyingContract)}, minValiditySeconds ${minValidity}`);
});
