/** Shared setup for the smoke-test scripts. */
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { erc20Abi, type Address } from "viem";
import { ARC_TESTNET, optionalEnv, privateKeyFromEnv } from "../src/config.ts";

export function buyerClient(): GatewayClient {
  const rpcUrl = optionalEnv("ARC_RPC_URL", "");
  return new GatewayClient({
    chain: ARC_TESTNET.chainName,
    privateKey: privateKeyFromEnv("BUYER_PRIVATE_KEY"),
    ...(rpcUrl ? { rpcUrl } : {}),
  });
}

/**
 * Reads decimals() from the USDC contract onchain and checks it against the SDK
 * chain config, so amount math never rests on an assumed constant.
 */
export async function verifiedUsdcDecimals(client: GatewayClient): Promise<number> {
  const onchain = await client.publicClient.readContract({
    address: ARC_TESTNET.usdc.address,
    abi: erc20Abi,
    functionName: "decimals",
  });
  if (onchain !== ARC_TESTNET.usdc.decimals) {
    throw new Error(`USDC decimals mismatch: onchain ${onchain}, SDK config ${ARC_TESTNET.usdc.decimals}`);
  }
  return onchain;
}

export async function erc20Balance(client: GatewayClient, address: Address): Promise<bigint> {
  return client.publicClient.readContract({
    address: ARC_TESTNET.usdc.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

export function fail(message: string, code = 1): never {
  console.error(`\n✗ ${message}`);
  process.exit(code);
}
