/**
 * Binds a spending decision to the exact payment that gets signed.
 *
 * What a Gateway nanopayment signature covers (read from the SDK 4.0.0 source,
 * BatchEvmScheme.signAuthorization):
 *   EIP-712 domain  name "GatewayWalletBatched", version, chainId,
 *                   verifyingContract = Gateway Wallet, salt = asset (version "2" only)
 *   message         from, to (payee), value (amount), validAfter, validBefore, nonce
 * NOT covered by the signature: the resource URL, and (in version "1") the asset.
 * Gateway accepts version "1" for USDC only, so the asset is still pinned by protocol rule,
 * and the resource is pinned here by only ever sending the signature to the approved URL.
 *
 * Flow: decode the 402 -> selectApprovedOption() (all terms must match) ->
 * createGuardedSigner() (re-checks the typed data at the moment of signing, once) ->
 * assertAuthorizationMatches() (re-checks the produced payload) -> send.
 * GatewayClient.pay() is NOT used: it re-negotiates the 402 itself and has no way to
 * cap or pin the terms.
 */
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION_V2,
} from "@circle-fin/x402-batching";
import type { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { pad, type Address, type Hex, type LocalAccount } from "viem";

export type BatchEvmSigner = ConstructorParameters<typeof BatchEvmScheme>[0];
type SignTypedDataParams = Parameters<BatchEvmSigner["signTypedData"]>[0];

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: number;
  resource?: ResourceInfo;
  accepts: PaymentRequirements[];
  error?: string;
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface BatchPayload {
  signature: Hex;
  authorization: Authorization;
}

/** The exact terms a spending decision approved. Nothing is signed unless all of them match. */
export interface ApprovedTerms {
  resourceUrl: string;
  network: string;
  chainId: number;
  asset: Address;
  payTo: Address;
  /** Base units of `asset`. */
  amount: bigint;
  /** Gateway Wallet contract (EIP-712 verifyingContract). */
  verifyingContract: Address;
  payer: Address;
  allowedVersions: readonly string[];
  minValiditySeconds: number;
  maxValiditySeconds: number;
}

export class TermsMismatchError extends Error {
  readonly mismatches: string[];
  constructor(context: string, mismatches: string[]) {
    super(`${context} does not match the approved terms: ${mismatches.join("; ")}`);
    this.name = "TermsMismatchError";
    this.mismatches = mismatches;
  }
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)),
    "utf8",
  ).toString("base64");
}

export function decodeHeader<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
  } catch {
    throw new Error("Malformed base64 JSON in x402 header");
  }
}

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const normalizeUrl = (url: string) => new URL(url).href;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function parseBaseUnits(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

export function optionMismatches(option: PaymentRequirements, terms: ApprovedTerms): string[] {
  const problems: string[] = [];
  if (option.scheme !== CIRCLE_BATCHING_SCHEME) problems.push(`scheme "${option.scheme}"`);
  if (option.network !== terms.network) problems.push(`network ${option.network} != ${terms.network}`);
  if (!same(option.asset, terms.asset)) problems.push(`asset ${option.asset} != ${terms.asset}`);
  if (!same(option.payTo, terms.payTo)) problems.push(`payTo ${option.payTo} != ${terms.payTo}`);
  const amount = parseBaseUnits(option.amount);
  if (amount === undefined) problems.push(`amount "${option.amount}" is not an integer of base units`);
  else if (amount !== terms.amount) problems.push(`amount ${amount} != approved ${terms.amount}`);
  if (option.extra?.name !== CIRCLE_BATCHING_NAME) problems.push(`extra.name "${String(option.extra?.name)}"`);
  if (!same(option.extra?.verifyingContract, terms.verifyingContract)) {
    problems.push(`verifyingContract ${String(option.extra?.verifyingContract)} != ${terms.verifyingContract}`);
  }
  const version = String(option.extra?.version ?? "");
  if (!terms.allowedVersions.includes(version)) {
    problems.push(`authorization version "${version}" not in ${JSON.stringify(terms.allowedVersions)}`);
  }
  if (!Number.isInteger(option.maxTimeoutSeconds) || option.maxTimeoutSeconds > terms.maxValiditySeconds) {
    problems.push(`maxTimeoutSeconds ${option.maxTimeoutSeconds} > ${terms.maxValiditySeconds}`);
  }
  return problems;
}

/** Picks the single Gateway option from a 402 and returns it only if every term matches. */
export function selectApprovedOption(paymentRequired: PaymentRequired, terms: ApprovedTerms): PaymentRequirements {
  const problems: string[] = [];
  if (paymentRequired.x402Version !== 2) problems.push(`x402Version ${paymentRequired.x402Version} (expected 2)`);
  const resourceUrl = paymentRequired.resource?.url;
  if (!resourceUrl) problems.push("402 has no resource.url");
  else if (normalizeUrl(resourceUrl) !== normalizeUrl(terms.resourceUrl)) {
    problems.push(`resource ${resourceUrl} != approved ${terms.resourceUrl}`);
  }
  const candidates = (paymentRequired.accepts ?? []).filter(
    (o) => o.extra?.name === CIRCLE_BATCHING_NAME && o.network === terms.network,
  );
  if (candidates.length === 0) problems.push(`no ${CIRCLE_BATCHING_NAME} option on ${terms.network}`);
  if (candidates.length > 1) problems.push(`${candidates.length} Gateway options on ${terms.network}; refusing to guess`);
  if (problems.length) throw new TermsMismatchError("402 offer", problems);

  const option = candidates[0];
  const mismatches = optionMismatches(option, terms);
  if (mismatches.length) throw new TermsMismatchError("402 offer", mismatches);
  return option;
}

function typedDataMismatches(
  params: SignTypedDataParams,
  terms: ApprovedTerms,
  option: PaymentRequirements,
  now: number,
): string[] {
  const problems: string[] = [];
  const { domain, message } = params;
  if (params.primaryType !== "TransferWithAuthorization") problems.push(`primaryType ${params.primaryType}`);
  if (domain.name !== CIRCLE_BATCHING_NAME) problems.push(`domain.name ${domain.name}`);
  if (domain.version !== String(option.extra?.version)) problems.push(`domain.version ${domain.version}`);
  if (domain.chainId !== terms.chainId) problems.push(`domain.chainId ${domain.chainId} != ${terms.chainId}`);
  if (!same(domain.verifyingContract, terms.verifyingContract)) {
    problems.push(`domain.verifyingContract ${domain.verifyingContract} != ${terms.verifyingContract}`);
  }
  if (domain.version === CIRCLE_BATCHING_VERSION_V2) {
    if (!domain.salt || !same(domain.salt, pad(terms.asset))) problems.push("domain.salt does not bind the approved asset");
  } else if (domain.salt !== undefined) {
    problems.push("unexpected domain.salt for version 1");
  }
  if (!same(message.from, terms.payer)) problems.push(`from ${String(message.from)} != payer ${terms.payer}`);
  if (!same(message.to, terms.payTo)) problems.push(`to ${String(message.to)} != payTo ${terms.payTo}`);
  const value = parseBaseUnits(message.value);
  if (value !== terms.amount) problems.push(`value ${String(message.value)} != approved ${terms.amount}`);
  const validAfter = parseBaseUnits(message.validAfter);
  const validBefore = parseBaseUnits(message.validBefore);
  if (validAfter === undefined || validAfter > BigInt(now + 60)) problems.push(`validAfter ${String(message.validAfter)}`);
  if (validBefore === undefined) {
    problems.push("validBefore missing");
  } else {
    const window = validBefore - BigInt(now);
    if (window < BigInt(terms.minValiditySeconds) || window > BigInt(terms.maxValiditySeconds)) {
      problems.push(`validity window ${window}s outside [${terms.minValiditySeconds}, ${terms.maxValiditySeconds}]`);
    }
  }
  if (typeof message.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) problems.push("nonce is not 32 bytes");
  return problems;
}

/**
 * A signer for BatchEvmScheme that signs exactly one TransferWithAuthorization,
 * and only if its typed data matches the approved terms and option. Anything else throws
 * before the private key is used.
 */
export function createGuardedSigner(
  account: LocalAccount,
  terms: ApprovedTerms,
  option: PaymentRequirements,
  clock: () => number = nowSeconds,
): BatchEvmSigner {
  if (!same(account.address, terms.payer)) throw new Error("Signer account is not the approved payer");
  let used = false;
  return {
    address: account.address,
    async signTypedData(params) {
      if (used) throw new Error("Refusing to sign: this approval already produced a signature");
      const problems = typedDataMismatches(params, terms, option, clock());
      if (problems.length) throw new TermsMismatchError("Authorization to sign", problems);
      used = true;
      return account.signTypedData(params as Parameters<LocalAccount["signTypedData"]>[0]);
    },
  };
}

/** Defense in depth: re-check the payload the SDK produced before it leaves the process. */
export function assertAuthorizationMatches(
  payload: BatchPayload,
  terms: ApprovedTerms,
  clock: () => number = nowSeconds,
): void {
  const a = payload.authorization;
  const problems: string[] = [];
  if (!same(a.from, terms.payer)) problems.push(`from ${a.from}`);
  if (!same(a.to, terms.payTo)) problems.push(`to ${a.to}`);
  if (parseBaseUnits(a.value) !== terms.amount) problems.push(`value ${a.value}`);
  const validBefore = parseBaseUnits(a.validBefore);
  const window = validBefore === undefined ? undefined : validBefore - BigInt(clock());
  if (window === undefined || window < BigInt(terms.minValiditySeconds) || window > BigInt(terms.maxValiditySeconds)) {
    problems.push(`validBefore ${a.validBefore}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) problems.push("nonce");
  if (!/^0x[0-9a-fA-F]+$/.test(payload.signature)) problems.push("signature");
  if (problems.length) throw new TermsMismatchError("Signed authorization", problems);
}
