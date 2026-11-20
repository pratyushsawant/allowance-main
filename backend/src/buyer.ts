/**
 * Buys x402 resources under the ledger's control.
 *
 * purchase(): quote (unpaid request -> 402) -> ledger.reserve (policy + budget, atomic)
 *             -> execute() only if this call created the reservation.
 * execute():  fresh quote that must match the reserved terms exactly -> guarded signature
 *             -> ledger "signed" (nonce written BEFORE sending) -> send -> classify outcome.
 *
 * Outcome rules (a signed authorization stays settleable until validBefore, ~7 days):
 *   2xx                                    -> accepted
 *   402 with a permanently-invalid reason  -> rejected (released): Gateway can never settle it
 *   anything else (timeout, 5xx, other 402) -> pending_unknown (held); the reconciler resolves it by nonce
 */
import { CIRCLE_BATCHING_NAME } from "@circle-fin/x402-batching";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { getAddress, type LocalAccount } from "viem";
import { ARC_TESTNET, MAX_AUTH_VALIDITY_SECONDS, MIN_AUTH_VALIDITY_SECONDS } from "./config.ts";
import type { Ledger, Purchase, PurchaseState, TransitionPatch } from "./ledger.ts";
import type { Quote } from "./policy.ts";
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
} from "./x402.ts";

/** Gateway error codes after which the signed authorization can never settle (SDK error reference). */
const PERMANENTLY_INVALID = new Set([
  "invalid_signature", "address_mismatch", "amount_mismatch", "unsupported_scheme", "unsupported_network",
  "unsupported_asset", "invalid_payload", "authorization_validity_too_short", "authorization_expired", "self_transfer",
]);

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteError";
  }
}

export interface BuyerDeps {
  ledger: Ledger;
  account: LocalAccount;
  /** Payer's Gateway `available` balance in USDC base units. */
  gatewayAvailable: () => Promise<bigint>;
  fetchImpl?: typeof fetch;
  quoteTimeoutMs?: number;
  paidRequestTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface PurchaseRequest {
  idempotencyKey: string;
  itemId: string;
  sellerId: string;
  resourceUrl: string;
}

export function createBuyer(deps: BuyerDeps) {
  const http = deps.fetchImpl ?? fetch;
  const quoteTimeoutMs = deps.quoteTimeoutMs ?? 15_000;
  const paidTimeoutMs = deps.paidRequestTimeoutMs ?? 45_000;
  const log = deps.log ?? (() => {});
  const { ledger, account } = deps;

  async function fetchOffer(url: string): Promise<PaymentRequired> {
    let res: Response;
    try {
      res = await http(url, { signal: AbortSignal.timeout(quoteTimeoutMs) });
    } catch (err) {
      throw new QuoteError(`Seller unreachable: ${(err as Error).message}`);
    }
    await res.body?.cancel().catch(() => {});
    if (res.status !== 402) throw new QuoteError(`Seller answered HTTP ${res.status} instead of 402`);
    const header = res.headers.get("payment-required");
    if (!header) throw new QuoteError("Seller's 402 has no PAYMENT-REQUIRED header");
    try {
      return decodeHeader<PaymentRequired>(header);
    } catch {
      throw new QuoteError("Seller's PAYMENT-REQUIRED header is malformed");
    }
  }

  /** Reads the seller's terms without trusting them; the policy decides what to do with them. */
  function quoteFrom(offer: PaymentRequired): Quote {
    const option = (offer.accepts ?? []).find(
      (o) => o.extra?.name === CIRCLE_BATCHING_NAME && o.network === ARC_TESTNET.network,
    );
    if (!option) throw new QuoteError(`Seller offers no Gateway payment on ${ARC_TESTNET.network}`);
    if (!/^\d+$/.test(option.amount)) throw new QuoteError("Seller's price is not an integer amount");
    let payTo: string;
    try {
      payTo = getAddress(option.payTo);
    } catch {
      throw new QuoteError("Seller's payTo is not an address");
    }
    return { payTo, network: option.network, asset: option.asset, amount: BigInt(option.amount) };
  }

  function termsFor(p: Purchase): ApprovedTerms {
    return {
      resourceUrl: p.resourceUrl,
      network: p.network,
      chainId: ARC_TESTNET.chainId,
      asset: getAddress(p.asset),
      payTo: getAddress(p.payTo),
      amount: p.amount,
      verifyingContract: ARC_TESTNET.gatewayWallet,
      payer: account.address,
      allowedVersions: ["1", "2"],
      minValiditySeconds: MIN_AUTH_VALIDITY_SECONDS,
      maxValiditySeconds: MAX_AUTH_VALIDITY_SECONDS,
    };
  }

  async function execute(p: Purchase): Promise<Purchase> {
    const terms = termsFor(p);
    let offer: PaymentRequired;
    let option: PaymentRequirements;
    try {
      offer = await fetchOffer(p.resourceUrl);
      option = selectApprovedOption(offer, terms);
    } catch (err) {
      const reason =
        err instanceof TermsMismatchError
          ? `Seller's terms changed since approval: ${err.mismatches.join("; ")}`
          : `Could not get a fresh quote: ${(err as Error).message}`;
      return ledger.transition(p.id, ["reserved"], "aborted", { reason });
    }

    let payload: BatchPayload;
    let x402Version: number;
    try {
      const scheme = new BatchEvmScheme(createGuardedSigner(account, terms, option));
      const created = await scheme.createPaymentPayload(2, option);
      payload = created.payload as unknown as BatchPayload;
      x402Version = created.x402Version;
      assertAuthorizationMatches(payload, terms);
    } catch (err) {
      // Nothing left the process; the signature (if any) is discarded.
      return ledger.transition(p.id, ["reserved"], "aborted", { reason: `Signing refused: ${(err as Error).message}` });
    }

    // Write-ahead: the nonce is on disk before the authorization can reach anyone.
    const { nonce, validBefore } = payload.authorization;
    ledger.transition(p.id, ["reserved"], "signed", { nonce, validBefore: Number(validBefore) });

    let to: PurchaseState;
    let patch: TransitionPatch;
    try {
      const res = await http(p.resourceUrl, {
        headers: {
          "PAYMENT-SIGNATURE": encodeHeader({ x402Version, payload, accepted: option, resource: offer.resource }),
        },
        signal: AbortSignal.timeout(paidTimeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; data?: unknown; payment?: { transaction?: string } };
      if (res.ok) {
        const header = res.headers.get("payment-response");
        const settle = header ? decodeHeader<{ transaction?: string }>(header) : undefined;
        to = "accepted";
        patch = {
          reason: "Paid",
          gatewayTransferId: body.payment?.transaction ?? settle?.transaction,
          result: body.data ?? null,
        };
      } else if (res.status === 402 && body.error && PERMANENTLY_INVALID.has(body.error)) {
        to = "rejected";
        patch = { reason: `Gateway refused the payment: ${body.error}` };
      } else {
        to = "pending_unknown";
        patch = { reason: `Seller answered HTTP ${res.status}${body.error ? ` (${body.error})` : ""}; outcome unconfirmed` };
      }
    } catch (err) {
      const e = err as Error;
      to = "pending_unknown";
      patch = { reason: e.name === "TimeoutError" ? "No answer from the seller in time; outcome unconfirmed" : `Network error: ${e.message}` };
    }
    log(`[buyer] ${p.id} ${p.itemId} -> ${to} (nonce ${nonce})`);
    return ledger.transition(p.id, ["signed"], to, patch);
  }

  return {
    async purchase(req: PurchaseRequest): Promise<Purchase> {
      const existing = ledger.getByKey(req.idempotencyKey);
      if (existing) return existing;
      const quote = quoteFrom(await fetchOffer(req.resourceUrl));
      const gatewayAvailable = await deps.gatewayAvailable();
      const { purchase, created } = ledger.reserve({ ...req, quote, gatewayAvailable });
      if (!created) return purchase; // another request with the same key won the race
      return purchase.state === "reserved" ? execute(purchase) : purchase;
    },

    async approve(id: string): Promise<Purchase> {
      const gatewayAvailable = await deps.gatewayAvailable();
      const p = ledger.approve(id, gatewayAvailable);
      return p.state === "reserved" ? execute(p) : p;
    },
  };
}

export type Buyer = ReturnType<typeof createBuyer>;
