/**
 * Spending policy. Pure: no I/O, no clock. The ledger supplies the state inside the same
 * SQLite transaction that records the decision, so concurrent requests cannot both pass.
 * The LLM can request a purchase; only `humanApproved` (set by the operator-only route)
 * can lift a needs_approval decision.
 */
import { formatBaseUnits } from "./units.ts";

export interface PolicyConfig {
  network: string;
  asset: string;
  /** Decimals of `asset`, used only for human-readable reasons. */
  decimals: number;
  allowedPayees: readonly string[];
  autoApproveMax: bigint;
  perCallMax: bigint;
  dailyCap: bigint;
  timeZone: string;
}

export interface PolicyInputs {
  frozen: boolean;
  frozenReason: string | null;
  /** Today's held + spent amount (reserved, signed, accepted, settled, pending). */
  committedToday: bigint;
  /** Gateway `available` minus amounts that are held but not yet debited by Gateway. */
  availableFunds: bigint;
}

/** The terms read from the seller's 402 offer. */
export interface Quote {
  payTo: string;
  network: string;
  asset: string;
  amount: bigint;
}

export type DenyCode =
  | "frozen"
  | "wrong_network"
  | "wrong_asset"
  | "payee_not_allowlisted"
  | "invalid_amount"
  | "over_per_call_cap"
  | "over_daily_cap"
  | "insufficient_funds";

export type Decision =
  | { kind: "allow"; reason: string }
  | { kind: "needs_approval"; reason: string }
  | { kind: "deny"; code: DenyCode; reason: string };

export function evaluate(
  quote: Quote,
  inputs: PolicyInputs,
  config: PolicyConfig,
  opts: { humanApproved?: boolean } = {},
): Decision {
  const usdc = (v: bigint) => `$${formatBaseUnits(v, config.decimals)}`;
  const deny = (code: DenyCode, reason: string): Decision => ({ kind: "deny", code, reason });

  if (inputs.frozen) return deny("frozen", `Spending is frozen${inputs.frozenReason ? `: ${inputs.frozenReason}` : ""}`);
  if (quote.network !== config.network) return deny("wrong_network", `Seller asks for network ${quote.network}`);
  if (quote.asset.toLowerCase() !== config.asset.toLowerCase()) return deny("wrong_asset", `Seller asks for asset ${quote.asset}`);
  if (!config.allowedPayees.some((p) => p.toLowerCase() === quote.payTo.toLowerCase())) {
    return deny("payee_not_allowlisted", `Seller ${quote.payTo} is not on the allowlist`);
  }
  if (quote.amount <= 0n) return deny("invalid_amount", "Price must be positive");
  if (quote.amount > config.perCallMax) {
    return deny("over_per_call_cap", `${usdc(quote.amount)} is over the ${usdc(config.perCallMax)} per-purchase cap`);
  }
  if (inputs.committedToday + quote.amount > config.dailyCap) {
    return deny(
      "over_daily_cap",
      `${usdc(quote.amount)} would exceed today's ${usdc(config.dailyCap)} cap (${usdc(inputs.committedToday)} already committed)`,
    );
  }
  if (quote.amount > inputs.availableFunds) {
    return deny("insufficient_funds", `${usdc(quote.amount)} is more than the ${usdc(inputs.availableFunds)} available`);
  }
  if (quote.amount > config.autoApproveMax && !opts.humanApproved) {
    return { kind: "needs_approval", reason: `${usdc(quote.amount)} is over the ${usdc(config.autoApproveMax)} auto-approve limit` };
  }
  return {
    kind: "allow",
    reason: opts.humanApproved ? "Approved by a person" : `Within the ${usdc(config.autoApproveMax)} auto-approve limit`,
  };
}
