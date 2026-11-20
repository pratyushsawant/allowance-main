/**
 * Allowance backend: one long-running Node 22 process.
 *   npm start   (reads backend/.env)
 * Serves the agent/operator API and the catalog's x402 sellers, runs the reconciler, and runs the
 * odds recorder unless RECORDER_ENABLED=0 (set that while a standalone `npm run recorder` is running).
 */
import { createServer } from "node:http";
import { GatewayClient, type TransferResponse } from "@circle-fin/x402-batching/client";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registerApi } from "./api.ts";
import { createAuth } from "./auth.ts";
import { createCors, parseOrigins } from "./cors.ts";
import { createSessionSigner } from "./session.ts";
import { createVoiceSessions } from "./voice.ts";
import { registerStreamsWebhook } from "./streams.ts";
import { createBuyer } from "./buyer.ts";
import {
  ARC_TESTNET, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS, addressFromEnv, explorerTx, gatewayApiUrl, optionalEnv,
  policyConfigFromEnv, privateKeyFromEnv, tokenFromEnv,
} from "./config.ts";
import { openDatabase } from "./db.ts";
import { createRouter } from "./http.ts";
import { createLedger } from "./ledger.ts";
import { createMarketData } from "./market-data.ts";
import { createReconciler, type GatewayTransfer } from "./reconciler.ts";
import { createRecorder } from "./recorder.ts";
import { checkLiveGateway, registerSellers } from "./sellers.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const host = optionalEnv("HOST", "127.0.0.1");
const port = Number(optionalEnv("PORT", "8787"));
// Base URL the built-in sellers advertise and the buyer calls. Only our own buyer uses them, so
// loopback is right even when HOST=0.0.0.0 in a container; override only if sellers run elsewhere.
const publicBaseUrl = optionalEnv("PUBLIC_BASE_URL", `http://127.0.0.1:${port}`).replace(/\/$/, "");
const qnToken = process.env.QN_STREAM_SECURITY_TOKEN?.trim() || undefined;
if (qnToken && qnToken.length < 32) throw new Error("QN_STREAM_SECURITY_TOKEN must be at least 32 characters (value not shown)");
const buyerKey = privateKeyFromEnv("BUYER_PRIVATE_KEY");
const payTo = { "odds-desk": addressFromEnv("SELLER_ADDRESS"), "shady-reports": addressFromEnv("UNLISTED_SELLER_ADDRESS") };
const agentToken = tokenFromEnv("AGENT_API_TOKEN");
const operatorToken = tokenFromEnv("OPERATOR_API_TOKEN");
if (agentToken === operatorToken) throw new Error("AGENT_API_TOKEN and OPERATOR_API_TOKEN must differ");
const sessions = createSessionSigner(tokenFromEnv("SESSION_SECRET"));
const accessCode = (name: string) => {
  const v = process.env[name]?.trim();
  if (v && v.length < 10) throw new Error(`${name} must be at least 10 characters (value not shown)`);
  return v || undefined;
};
const accessCodes = { agent: accessCode("DEMO_ACCESS_CODE"), operator: accessCode("OPERATOR_ACCESS_CODE") };
if (accessCodes.agent && accessCodes.agent === accessCodes.operator) throw new Error("DEMO_ACCESS_CODE and OPERATOR_ACCESS_CODE must differ");
const sessionTtlSeconds = {
  agent: Number(optionalEnv("AGENT_SESSION_TTL_SECONDS", "7200")),
  operator: Number(optionalEnv("OPERATOR_SESSION_TTL_SECONDS", "3600")),
};
const corsOrigins = parseOrigins(optionalEnv("CORS_ALLOWED_ORIGINS", ""));
const voice = createVoiceSessions({
  apiKey: process.env.ELEVENLABS_API_KEY?.trim() || undefined,
  agentId: process.env.ELEVENLABS_AGENT_ID?.trim() || undefined,
  apiBase: optionalEnv("ELEVENLABS_API_BASE", ""),
});
const version = optionalEnv("AUTH_VERSION", "2");
const policy = policyConfigFromEnv();

const db = openDatabase();
const rpcUrl = optionalEnv("ARC_RPC_URL", "");
const gateway = new GatewayClient({ chain: ARC_TESTNET.chainName, privateKey: buyerKey, ...(rpcUrl ? { rpcUrl } : {}) });
const facilitator = new BatchFacilitatorClient({ url: gatewayApiUrl() });
const { minValiditySeconds } = await checkLiveGateway(facilitator, version);

const ledger = createLedger(db, policy);
const gatewayAvailable = async () => (await gateway.getBalances()).gateway.available;
const buyer = createBuyer({ ledger, account: privateKeyToAccount(buyerKey), gatewayAvailable, log });
// SDK 4.0.0 types TransferResponse without txHash (index signature only); the live API returns it (verified).
const toTransfer = (t: TransferResponse): GatewayTransfer => ({
  id: t.id,
  status: t.status,
  txHash: typeof t.txHash === "string" ? t.txHash : null,
});
const reconciler = createReconciler(
  ledger,
  {
    getTransferById: async (id) => toTransfer(await gateway.getTransferById(id)),
    findByNonce: async (nonce) => {
      const [first] = (await gateway.searchTransfers({ nonce: nonce as Hex })).transfers;
      return first ? toTransfer(first) : undefined;
    },
  },
  { log },
);
const market = createMarketData(db);
const recorder = optionalEnv("RECORDER_ENABLED", "1") === "0" ? undefined : createRecorder(db, { log });

const router = createRouter(log);
registerSellers(router, {
  facilitator, publicBaseUrl, payTo, version, market, log,
  maxTimeoutSeconds: Math.max(GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS, minValiditySeconds),
});
const auth = createAuth({ agentToken, operatorToken, sessions });
registerApi(router, {
  ledger, buyer, market, policy, publicBaseUrl, gatewayAvailable, voice, sessions, accessCodes, sessionTtlSeconds, auth,
});
registerStreamsWebhook(router, {
  db, ledger, auth, securityToken: qnToken, log, explorerTx,
  agent: gateway.address, gatewayWallet: ARC_TESTNET.gatewayWallet, gatewayMinter: ARC_TESTNET.gatewayMinter,
  chainId: ARC_TESTNET.chainId, usdcDecimals: ARC_TESTNET.usdc.decimals,
});

const cors = createCors(corsOrigins);
const server = createServer((req, res) => {
  if (cors(req, res)) return;
  void router.handle(req, res);
});
server.listen(port, host, () => {
  log(`[server] listening on http://${host}:${port} (public base ${publicBaseUrl})`);
  log(`[server] payer ${gateway.address}; allowlist ${policy.allowedPayees.join(", ")}; buyer auth version ${version}`);
  log(`[server] recorder ${recorder ? "on" : "off (RECORDER_ENABLED=0)"}; reconciler every 30 s`);
  log(`[server] sessions: agent login ${accessCodes.agent ? "on" : "off (no DEMO_ACCESS_CODE)"}, operator login ${accessCodes.operator ? "on" : "off (no OPERATOR_ACCESS_CODE)"}`);
  log(`[server] voice: ${voice.configured ? "configured" : "not configured (set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID)"}; CORS origins: ${corsOrigins.join(", ") || "none"}`);
  log(`[server] streams webhook: ${qnToken ? "POST /webhooks/quicknode (HMAC verified)" : "off (set QN_STREAM_SECURITY_TOKEN)"}; watching ${gateway.address}`);
});
reconciler.start();
recorder?.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`[server] ${signal}: shutting down`);
    recorder?.stop();
    reconciler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
