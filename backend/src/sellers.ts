/**
 * The catalog's x402 sellers, served by the same process at /sellers/*.
 * Settles through BatchFacilitatorClient against the seller's OWN requirements (never the
 * buyer-supplied copy), refuses signatures for a different resource, never charges for an
 * unknown event, and never delivers when the settlement outcome is unknown.
 */
import { CIRCLE_BATCHING_NAME, CIRCLE_BATCHING_SCHEME } from "@circle-fin/x402-batching";
import type { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { buildDeepBrief } from "./brief.ts";
import { ARC_TESTNET } from "./config.ts";
import { CATALOG, TICKER_PATTERN, type CatalogItem, type SellerId } from "./catalog.ts";
import { HttpError, sendJson, type Router } from "./http.ts";
import type { MarketData } from "./market-data.ts";
import { toBaseUnits } from "./units.ts";
import { decodeHeader, encodeHeader, type BatchPayload, type PaymentRequired, type PaymentRequirements, type ResourceInfo } from "./x402.ts";

const MAX_POINTS_PER_CONTRACT = 500;

/** Cross-checks the live Gateway against the SDK constants before any price is advertised. */
export async function checkLiveGateway(facilitator: BatchFacilitatorClient, version: string): Promise<{ minValiditySeconds: number }> {
  const supported = await facilitator.getSupported();
  const kind = supported.kinds.find(
    (k) => k.network === ARC_TESTNET.network && k.scheme === CIRCLE_BATCHING_SCHEME && k.extra?.name === CIRCLE_BATCHING_NAME,
  );
  if (!kind) throw new Error(`Gateway does not list ${CIRCLE_BATCHING_NAME} on ${ARC_TESTNET.network}`);
  if (String(kind.extra?.verifyingContract).toLowerCase() !== ARC_TESTNET.gatewayWallet.toLowerCase()) {
    throw new Error(`Live Gateway Wallet ${String(kind.extra?.verifyingContract)} != SDK ${ARC_TESTNET.gatewayWallet}`);
  }
  const assets = (kind.extra?.assets ?? []) as Array<{ address: string; decimals: number; authorizationVersions?: string[] }>;
  const usdc = assets.find((a) => a.address.toLowerCase() === ARC_TESTNET.usdc.address.toLowerCase());
  if (!usdc || usdc.decimals !== ARC_TESTNET.usdc.decimals) throw new Error("Live Gateway USDC entry missing or decimals differ");
  if (!usdc.authorizationVersions?.includes(version)) throw new Error(`Gateway does not accept authorization version ${version} for USDC`);
  return { minValiditySeconds: Number(kind.extra?.minValiditySeconds ?? 0) };
}

class SettleTimeout extends Error {}
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new SettleTimeout(`no answer in ${ms} ms`)), ms).unref())]);

export interface SellerDeps {
  facilitator: BatchFacilitatorClient;
  publicBaseUrl: string;
  payTo: Record<SellerId, string>;
  version: string;
  maxTimeoutSeconds: number;
  market: MarketData;
  settleTimeoutMs?: number;
  log?: (line: string) => void;
}

export function registerSellers(router: Router, deps: SellerDeps): void {
  const log = deps.log ?? (() => {});
  const settleTimeoutMs = deps.settleTimeoutMs ?? 30_000;

  function deliver(item: CatalogItem, ticker: string): unknown {
    switch (item.id) {
      case "odds_snapshot":
        return {
          event: deps.market.event(ticker),
          related: {
            item: "full_report", seller: "shady-reports", priceUsdc: "0.01",
            note: "A full report on this event is available from Shady Reports.",
          },
        };
      case "odds_history": {
        const h = deps.market.history(ticker);
        if (!h) return null;
        return { ...h, contracts: h.contracts.map((c) => ({ ...c, points: c.points.slice(-MAX_POINTS_PER_CONTRACT) })) };
      }
      case "deep_brief":
        return buildDeepBrief(deps.market, ticker);
      default:
        return { mock: true, note: "Placeholder report." };
    }
  }

  for (const item of CATALOG) {
    const pattern = item.path("TICKER").replace("TICKER", ":ticker");
    const requirementsFor = (): PaymentRequirements => ({
      scheme: CIRCLE_BATCHING_SCHEME,
      network: ARC_TESTNET.network,
      asset: ARC_TESTNET.usdc.address,
      amount: toBaseUnits(item.priceUsdc, ARC_TESTNET.usdc.decimals).toString(),
      payTo: deps.payTo[item.sellerId],
      maxTimeoutSeconds: deps.maxTimeoutSeconds,
      extra: { name: CIRCLE_BATCHING_NAME, version: deps.version, verifyingContract: ARC_TESTNET.gatewayWallet },
    });

    router.add("GET", pattern, async ({ req, res, params }) => {
      const ticker = params.ticker;
      if (!TICKER_PATTERN.test(ticker)) throw new HttpError(400, "invalid_ticker", "Malformed event ticker");
      if (!deps.market.event(ticker)) throw new HttpError(404, "unknown_event", "No recorded event with that ticker");
      const requirements = requirementsFor();
      const resource: ResourceInfo = { url: `${deps.publicBaseUrl}${item.path(ticker)}`, description: item.title, mimeType: "application/json" };

      const header = req.headers["payment-signature"];
      if (typeof header !== "string") {
        const offer: PaymentRequired = { x402Version: 2, resource, accepts: [requirements] };
        return sendJson(res, 402, { error: "payment_required" }, { "PAYMENT-REQUIRED": encodeHeader(offer) });
      }

      let signed: { x402Version: number; payload: BatchPayload; resource?: ResourceInfo };
      try {
        signed = decodeHeader(header);
      } catch {
        throw new HttpError(400, "malformed_payment_signature", "PAYMENT-SIGNATURE is not valid base64 JSON");
      }
      const nonce = signed.payload?.authorization?.nonce;
      if (signed.resource?.url !== resource.url) return sendJson(res, 402, { error: "resource_mismatch", nonce });

      try {
        const settle = await withTimeout(deps.facilitator.settle(signed as never, requirements), settleTimeoutMs);
        log(`[seller:${item.sellerId}] ${item.id} ${ticker} settle success=${settle.success} transaction=${settle.transaction} ${settle.errorReason ?? ""}`);
        if (!settle.success) return sendJson(res, 402, { error: settle.errorReason ?? "settlement_failed", nonce });
        return sendJson(
          res, 200,
          { data: deliver(item, ticker), payment: { transaction: settle.transaction, payer: settle.payer, network: settle.network, amount: requirements.amount, nonce } },
          { "PAYMENT-RESPONSE": encodeHeader(settle) },
        );
      } catch (err) {
        log(`[seller:${item.sellerId}] settlement outcome unknown for nonce ${nonce}: ${(err as Error).message}`);
        return sendJson(res, err instanceof SettleTimeout ? 504 : 502, { error: "settlement_status_unknown", nonce });
      }
    });
  }
}
