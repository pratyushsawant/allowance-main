/**
 * Writes backend/streams/filter.js: the Quicknode Streams filter for this deployment's agent wallet.
 * Paste it into the Stream's "Customize your payload" step (dataset: Logs, network: Arc Testnet).
 *   npm run streams:filter
 */
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, privateKeyFromEnv } from "../src/config.ts";
import { renderFilter } from "../src/streams-filter.ts";

const agent = privateKeyToAccount(privateKeyFromEnv("BUYER_PRIVATE_KEY")).address;
const out = new URL("../streams/filter.js", import.meta.url);
writeFileSync(out, renderFilter(ARC_TESTNET.chainId, [agent]));
console.log(`Wrote backend/streams/filter.js for agent wallet ${agent} on chain ${ARC_TESTNET.chainId}.`);
console.log("Quicknode test blocks with real activity for this wallet: 73167868 (faucet top-up), 73167978 and 73173107 (Gateway deposits).");
