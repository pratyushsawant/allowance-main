/**
 * Prints buyer and seller balances in every representation Phase 0 touches,
 * with the decimals used for each, so the unit conversions are visible.
 *   native   eth_getBalance            decimals from chain.nativeCurrency
 *   erc20    USDC.balanceOf            decimals() read onchain
 *   gateway  Gateway API (SDK)         base units of USDC
 */
import { ARC_TESTNET, addressFromEnv, explorerAddress } from "../src/config.ts";
import { formatBaseUnits } from "../src/units.ts";
import { buyerClient, erc20Balance, verifiedUsdcDecimals } from "./shared.ts";

const client = buyerClient();
const seller = addressFromEnv("SELLER_ADDRESS");
const usdcDecimals = await verifiedUsdcDecimals(client);
const nativeDecimals = ARC_TESTNET.nativeDecimals;

console.log(`Arc Testnet chain ${ARC_TESTNET.chainId} | USDC ${ARC_TESTNET.usdc.address}`);
console.log(`decimals: native ${nativeDecimals} (SDK chain config) | ERC-20 ${usdcDecimals} (onchain decimals()) | Gateway amounts use ERC-20 units`);

for (const [label, address] of [["buyer", client.address], ["seller", seller]] as const) {
  const native = await client.publicClient.getBalance({ address });
  const erc20 = await erc20Balance(client, address);
  const { gateway } = await client.getBalances(address);
  console.log(`\n${label} ${address}\n  ${explorerAddress(address)}`);
  console.log(`  native  ${formatBaseUnits(native, nativeDecimals)} USDC  (raw ${native})`);
  console.log(`  erc20   ${formatBaseUnits(erc20, usdcDecimals)} USDC  (raw ${erc20})`);
  console.log(
    `  gateway total ${formatBaseUnits(gateway.total, usdcDecimals)} | available ${formatBaseUnits(gateway.available, usdcDecimals)}` +
      ` | withdrawing ${formatBaseUnits(gateway.withdrawing, usdcDecimals)}  (raw available ${gateway.available})`,
  );
}
