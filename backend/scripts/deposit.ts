/**
 * One-time onchain deposit from the buyer wallet into its Gateway balance.
 * Dry run by default; pass --yes to send. Testnet only.
 *   npm run smoke:deposit            # shows the plan
 *   npm run smoke:deposit -- --yes   # sends approve + deposit, then waits for the balance
 */
import { ARC_TESTNET, explorerTx, optionalEnv } from "../src/config.ts";
import { appendEvidence } from "../src/evidence.ts";
import { formatBaseUnits, rescaleExact, toBaseUnits } from "../src/units.ts";
import { buyerClient, erc20Balance, fail, verifiedUsdcDecimals } from "./shared.ts";

const GAS_BUFFER_NATIVE = toBaseUnits("0.05", ARC_TESTNET.nativeDecimals); // keep some native USDC for gas
const WAIT_LIMIT_MS = 10 * 60_000;

const client = buyerClient();
const decimals = await verifiedUsdcDecimals(client);
const amountText = process.argv.slice(2).find((a) => /^\d/.test(a)) ?? optionalEnv("DEPOSIT_USDC", "1");
const amount = toBaseUnits(amountText, decimals);
const send = process.argv.includes("--yes");

const native = await client.publicClient.getBalance({ address: client.address });
const erc20 = await erc20Balance(client, client.address);
const before = await client.getBalances();
console.log(`buyer ${client.address}`);
console.log(`deposit ${formatBaseUnits(amount, decimals)} USDC (${amount} base units) into Gateway Wallet ${ARC_TESTNET.gatewayWallet}`);
console.log(`wallet erc20 ${formatBaseUnits(erc20, decimals)} | native ${formatBaseUnits(native, ARC_TESTNET.nativeDecimals)} | gateway available ${formatBaseUnits(before.gateway.available, decimals)}`);

if (erc20 < amount) fail(`Wallet holds ${formatBaseUnits(erc20, decimals)} USDC; fund ${client.address} from https://faucet.circle.com first.`);
if (native < rescaleExact(amount, decimals, ARC_TESTNET.nativeDecimals) + GAS_BUFFER_NATIVE) {
  fail("Not enough native USDC left for gas after the deposit; deposit less or fund more.");
}
if (!send) {
  console.log("\nDry run only. Re-run with `npm run smoke:deposit -- --yes` to send the approve and deposit transactions.");
  process.exit(0);
}

const started = Date.now();
const result = await client.deposit(amountText);
console.log(`\napproval tx ${result.approvalTxHash ?? "(none needed)"}${result.approvalTxHash ? `\n  ${explorerTx(result.approvalTxHash)}` : ""}`);
console.log(`deposit tx  ${result.depositTxHash}\n  ${explorerTx(result.depositTxHash)}`);

const receipt = await client.publicClient.waitForTransactionReceipt({ hash: result.depositTxHash });
console.log(`deposit receipt: status ${receipt.status}, block ${receipt.blockNumber}`);
if (receipt.status !== "success") fail("Deposit transaction reverted.");

const target = before.gateway.available + amount;
let available = before.gateway.available;
while (available < target) {
  if (Date.now() - started > WAIT_LIMIT_MS) {
    appendEvidence("deposits.jsonl", { status: "deposit_confirmed_balance_pending", depositTxHash: result.depositTxHash, amount });
    fail(`Deposit confirmed onchain but Gateway balance not credited after ${WAIT_LIMIT_MS / 60_000} min. Re-check with npm run smoke:balance.`, 2);
  }
  await new Promise((r) => setTimeout(r, 3000));
  available = (await client.getBalances()).gateway.available;
}
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`Gateway available ${formatBaseUnits(available, decimals)} USDC, credited ${seconds}s after submitting.`);
appendEvidence("deposits.jsonl", {
  status: "credited",
  buyer: client.address,
  amount,
  approvalTxHash: result.approvalTxHash ?? null,
  depositTxHash: result.depositTxHash,
  depositBlock: receipt.blockNumber,
  secondsUntilCredited: seconds,
});
