/**
 * Phase 0 configuration. Arc Testnet constants come from the installed Circle
 * SDK (and are cross-checked live by the scripts), never from memory.
 * Secrets are read from process.env and are never printed.
 */
import { CHAIN_CONFIGS, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS } from "@circle-fin/x402-batching/client";
import { getAddress, type Address, type Hex } from "viem";
import type { PolicyConfig } from "./policy.ts";
import { toBaseUnits } from "./units.ts";

const arc = CHAIN_CONFIGS.arcTestnet;
const usdc = arc.tokens.USDC;
if (!usdc) throw new Error("Installed SDK has no USDC entry for arcTestnet");

export const ARC_TESTNET_CHAIN_ID = 5042002;
if (arc.chain.id !== ARC_TESTNET_CHAIN_ID) {
  throw new Error(`SDK arcTestnet chain id is ${arc.chain.id}, expected ${ARC_TESTNET_CHAIN_ID}`);
}

/** Arc Testnet values as shipped in @circle-fin/x402-batching CHAIN_CONFIGS.arcTestnet. */
export const ARC_TESTNET = {
  chainName: "arcTestnet" as const,
  chainId: arc.chain.id,
  network: `eip155:${arc.chain.id}`,
  /** Native USDC (gas, eth_getBalance, EIP-7708 Transfer logs). */
  nativeDecimals: arc.chain.nativeCurrency.decimals,
  /** ERC-20 USDC interface; also the unit of x402 `amount` and Gateway balances. */
  usdc: { address: getAddress(usdc.address), decimals: usdc.decimals },
  gatewayWallet: getAddress(arc.gatewayWallet),
  gatewayMinter: getAddress(arc.gatewayMinter),
  gatewayDomain: arc.domain,
  explorerUrl: arc.chain.blockExplorers?.default.url ?? "",
};

/** Circle Gateway API for testnets (from Circle's nanopayments quickstarts). */
export const GATEWAY_API_URL_TESTNET = "https://gateway-api-testnet.circle.com";
const GATEWAY_API_HOST_MAINNET = "gateway-api.circle.com";

/** Live /v1/x402/supported reports minValiditySeconds = 604800 for Arc Testnet (checked 2026-11-20). */
export const MIN_AUTH_VALIDITY_SECONDS = 604_800;
/** The SDK signs validBefore = now + max(maxTimeoutSeconds, 604900). Refuse anything longer than that plus clock slack. */
export const MAX_AUTH_VALIDITY_SECONDS = GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS + 60;
export { GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS };

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

/** Throws one error naming every missing variable. Never echoes values. */
export function requireEnv(names: readonly string[]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing required variables in backend/.env: ${missing.join(", ")}. ` +
        "Run `npm run keys:generate` (creates testnet keys) or copy .env.example and fill them in.",
    );
  }
}

export function privateKeyFromEnv(name: string): Hex {
  requireEnv([name]);
  const value = process.env[name]!.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key (value not shown)`);
  }
  return value as Hex;
}

export function addressFromEnv(name: string): Address {
  requireEnv([name]);
  return getAddress(process.env[name]!.trim());
}

/** Testnet-only guard: refuses the mainnet Gateway host that BatchFacilitatorClient uses by default. */
export function gatewayApiUrl(): string {
  const url = optionalEnv("GATEWAY_API_URL", GATEWAY_API_URL_TESTNET).replace(/\/$/, "");
  if (new URL(url).host === GATEWAY_API_HOST_MAINNET) {
    throw new Error("GATEWAY_API_URL points at Circle's mainnet Gateway; Phase 0 is testnet-only");
  }
  return url;
}

/** Spending policy from env; defaults are the brief's ($0.25 auto-approve, $1.00 per call, $2.00 per day). */
export function policyConfigFromEnv(): PolicyConfig {
  const d = ARC_TESTNET.usdc.decimals;
  const payees = optionalEnv("ALLOWED_PAYEES", process.env.SELLER_ADDRESS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => getAddress(a));
  if (payees.length === 0) throw new Error("No allowed payees: set ALLOWED_PAYEES or SELLER_ADDRESS");
  return {
    network: ARC_TESTNET.network,
    asset: ARC_TESTNET.usdc.address,
    decimals: d,
    allowedPayees: payees,
    autoApproveMax: toBaseUnits(optionalEnv("AUTO_APPROVE_MAX_USDC", "0.25"), d),
    perCallMax: toBaseUnits(optionalEnv("PER_CALL_MAX_USDC", "1.00"), d),
    dailyCap: toBaseUnits(optionalEnv("DAILY_CAP_USDC", "2.00"), d),
    timeZone: optionalEnv("BUDGET_TIME_ZONE", "America/Chicago"),
  };
}

export function tokenFromEnv(name: string): string {
  requireEnv([name]);
  const value = process.env[name]!.trim();
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters (value not shown)`);
  return value;
}

export const explorerTx = (hash: string) => `${ARC_TESTNET.explorerUrl}/tx/${hash}`;
export const explorerAddress = (address: string) => `${ARC_TESTNET.explorerUrl}/address/${address}`;
