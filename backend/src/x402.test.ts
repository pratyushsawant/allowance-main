/**
 * Offline tests: no network, throwaway keys. They drive the real Circle
 * BatchEvmScheme through the guarded signer, so the checks run against the
 * SDK's actual EIP-712 typed data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { recoverTypedDataAddress, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, MAX_AUTH_VALIDITY_SECONDS, MIN_AUTH_VALIDITY_SECONDS } from "./config.ts";
import {
  assertAuthorizationMatches,
  createGuardedSigner,
  selectApprovedOption,
  TermsMismatchError,
  type ApprovedTerms,
  type BatchPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "./x402.ts";

const payer = privateKeyToAccount(generatePrivateKey());
const seller = privateKeyToAccount(generatePrivateKey()).address;
const other = privateKeyToAccount(generatePrivateKey()).address;
const RESOURCE = "http://127.0.0.1:4021/smoke/premium";

function terms(overrides: Partial<ApprovedTerms> = {}): ApprovedTerms {
  return {
    resourceUrl: RESOURCE,
    network: ARC_TESTNET.network,
    chainId: ARC_TESTNET.chainId,
    asset: ARC_TESTNET.usdc.address,
    payTo: seller,
    amount: 5000n,
    verifyingContract: ARC_TESTNET.gatewayWallet,
    payer: payer.address,
    allowedVersions: ["1", "2"],
    minValiditySeconds: MIN_AUTH_VALIDITY_SECONDS,
    maxValiditySeconds: MAX_AUTH_VALIDITY_SECONDS,
    ...overrides,
  };
}

function option(overrides: Partial<PaymentRequirements> = {}, version = "2"): PaymentRequirements {
  return {
    scheme: "exact",
    network: ARC_TESTNET.network,
    asset: ARC_TESTNET.usdc.address,
    amount: "5000",
    payTo: seller,
    maxTimeoutSeconds: 604_900,
    extra: { name: "GatewayWalletBatched", version, verifyingContract: ARC_TESTNET.gatewayWallet },
    ...overrides,
  };
}

const offer = (accepts: PaymentRequirements[], url = RESOURCE): PaymentRequired => ({
  x402Version: 2,
  resource: { url, description: "test", mimeType: "application/json" },
  accepts,
});

/** Wraps an account to record what was signed (and whether signing happened at all). */
function spy(account: LocalAccount) {
  const calls: unknown[] = [];
  const wrapped = {
    ...account,
    async signTypedData(params: Parameters<LocalAccount["signTypedData"]>[0]) {
      calls.push(params);
      return account.signTypedData(params);
    },
  } as LocalAccount;
  return { wrapped, calls };
}

test("selectApprovedOption returns the exact offered option when every term matches", () => {
  const o = option();
  assert.equal(selectApprovedOption(offer([o]), terms()), o);
});

test("selectApprovedOption rejects any changed term", () => {
  const cases: Array<[string, PaymentRequired]> = [
    ["payTo", offer([option({ payTo: other })])],
    ["amount", offer([option({ amount: "5001" })])],
    ["amount format", offer([option({ amount: "0.005" })])],
    ["asset", offer([option({ asset: ARC_TESTNET.gatewayWallet })])],
    ["network", offer([option({ network: "eip155:84532" })])],
    ["verifyingContract", offer([option({ extra: { name: "GatewayWalletBatched", version: "2", verifyingContract: other } })])],
    ["version", offer([option({}, "9")])],
    ["validity window", offer([option({ maxTimeoutSeconds: 10 * 86_400 })])],
    ["resource", offer([option()], "http://127.0.0.1:4021/smoke/other")],
    ["ambiguous", offer([option(), option()])],
    ["no gateway option", offer([{ ...option(), extra: { name: "SomethingElse" } }])],
  ];
  for (const [label, pr] of cases) {
    assert.throws(() => selectApprovedOption(pr, terms()), TermsMismatchError, label);
  }
});

for (const version of ["1", "2"]) {
  test(`SDK BatchEvmScheme + guarded signer produce a valid version ${version} authorization`, async () => {
    const o = option({}, version);
    const { wrapped, calls } = spy(payer);
    const scheme = new BatchEvmScheme(createGuardedSigner(wrapped, terms(), o));
    const result = await scheme.createPaymentPayload(2, o);
    const payload = result.payload as unknown as BatchPayload;

    assertAuthorizationMatches(payload, terms());
    assert.equal(calls.length, 1);
    const signed = calls[0] as Parameters<LocalAccount["signTypedData"]>[0] & { domain: { salt?: Hex } };
    const recovered = await recoverTypedDataAddress({ ...signed, signature: payload.signature } as never);
    assert.equal(recovered, payer.address);
    assert.equal(version === "2", signed.domain.salt !== undefined, "salt binds the asset only in version 2");
  });
}

test("guarded signer refuses typed data that differs from the approval, without touching the key", async () => {
  const approved = option({ amount: "5000" });
  const tampered = option({ amount: "6000" }); // what a misbehaving caller passes to the SDK
  const { wrapped, calls } = spy(payer);
  const scheme = new BatchEvmScheme(createGuardedSigner(wrapped, terms(), approved));
  await assert.rejects(scheme.createPaymentPayload(2, tampered), TermsMismatchError);
  const redirected = option({ payTo: other });
  const scheme2 = new BatchEvmScheme(createGuardedSigner(wrapped, terms(), approved));
  await assert.rejects(scheme2.createPaymentPayload(2, redirected), TermsMismatchError);
  assert.equal(calls.length, 0, "private key was never used");
});

test("guarded signer signs at most once per approval", async () => {
  const o = option();
  const scheme = new BatchEvmScheme(createGuardedSigner(payer, terms(), o));
  await scheme.createPaymentPayload(2, o);
  await assert.rejects(scheme.createPaymentPayload(2, o), /already produced a signature/);
});

test("guarded signer refuses an account that is not the approved payer", () => {
  assert.throws(() => createGuardedSigner(payer, terms({ payer: other }), option()), /not the approved payer/);
});
