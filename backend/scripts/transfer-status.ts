/**
 * Tracks one nanopayment from Gateway acceptance to onchain batch settlement.
 *   npm run smoke:status                       # last accepted payment in .smoke/payments.jsonl
 *   npm run smoke:status -- <transfer-uuid>
 *   npm run smoke:status -- --nonce 0x...      # reconcile a pending_unknown payment
 *   npm run smoke:status -- --wait 15          # poll up to 15 minutes
 * When Gateway reports a txHash, the receipt is read from Arc and the native USDC Transfer
 * logs in it are counted: one batch transaction can carry many payments.
 */
import { existsSync, readFileSync } from "node:fs";
import type { TransferResponse } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";
import { explorerTx } from "../src/config.ts";
import { appendEvidence } from "../src/evidence.ts";
import { buyerClient, fail } from "./shared.ts";

/** Arc's EIP-7708 native USDC system emitter and the ERC-20 Transfer topic (Arc "EVM differences" docs). */
const NATIVE_USDC_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FINAL = new Set(["completed", "failed"]);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const waitMinutes = Number(flag("--wait") ?? "0");
const nonce = flag("--nonce");
let transferId = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));

if (!transferId && !nonce) {
  const log = new URL("../.smoke/payments.jsonl", import.meta.url);
  const last = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).reverse()
        .find((r) => r.phase === "outcome" && r.status === "accepted" && r.transferId)
    : undefined;
  transferId = last?.transferId ?? fail("No transfer id or --nonce given, and no accepted payment in .smoke/payments.jsonl");
}

const client = buyerClient();
async function lookup(): Promise<TransferResponse | undefined> {
  if (transferId) return client.getTransferById(transferId);
  const { transfers } = await client.searchTransfers({ nonce: nonce as Hex });
  return transfers[0];
}

const deadline = Date.now() + waitMinutes * 60_000;
let lastStatus = "";
let receiptShown = false;
for (;;) {
  const t = await lookup();
  if (!t) {
    console.log(`${new Date().toISOString()} no Gateway transfer found for nonce ${nonce} (not received, or not yet indexed)`);
  } else if (t.status !== lastStatus || (t.txHash && !receiptShown)) {
    lastStatus = t.status;
    console.log(`${new Date().toISOString()} transfer ${t.id} status=${t.status} amount=${t.amount} from=${t.fromAddress} to=${t.toAddress} nonce=${t.nonce} txHash=${t.txHash ?? "-"}`);
    if (t.txHash && !receiptShown) {
      receiptShown = true;
      const txHash = String(t.txHash) as Hex;
      const receipt = await client.publicClient.getTransactionReceipt({ hash: txHash });
      const nativeTransfers = receipt.logs.filter(
        (l) => l.address.toLowerCase() === NATIVE_USDC_EMITTER && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC,
      ).length;
      console.log(`  settlement tx ${txHash}: status ${receipt.status}, block ${receipt.blockNumber}, ${receipt.logs.length} logs (${nativeTransfers} native USDC Transfer logs)`);
      console.log(`  ${explorerTx(txHash)}`);
      appendEvidence("settlements.jsonl", {
        transferId: t.id, nonce: t.nonce, status: t.status, txHash,
        block: receipt.blockNumber, receiptStatus: receipt.status, logs: receipt.logs.length, nativeTransfers,
      });
    }
  }
  if ((t && FINAL.has(t.status)) || Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, 15_000));
}
