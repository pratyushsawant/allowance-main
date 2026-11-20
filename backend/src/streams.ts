/**
 * Quicknode Streams webhook receiver (POST /webhooks/quicknode).
 *
 * Authentication (Quicknode docs, verified 2026-11-20): every delivery carries X-QN-Nonce,
 * X-QN-Timestamp and X-QN-Signature = hex HMAC-SHA256(securityToken, nonce + timestamp + payload),
 * where payload is the (decompressed) JSON body. The secret lives in QN_STREAM_SECURITY_TOKEN,
 * never in the URL.
 *
 * Nothing in the body is parsed or acted on until the signature verifies. Stale timestamps and
 * replayed nonces are refused; movements are deduplicated on chainId:txHash:logIndex, so retries and
 * replays are harmless. The only financial-state change a delivery can cause is a FREEZE, triggered
 * by an outbound transfer from the agent wallet that is not a Gateway deposit. Nothing here can
 * unfreeze, raise limits or move funds. Reply 2xx only after the database commit: Quicknode retries
 * otherwise and pauses the Stream after repeated failures.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { gunzipSync } from "node:zlib";
import type { Auth } from "./auth.ts";
import type { DB } from "./db.ts";
import { HttpError, sendJson, type Router } from "./http.ts";
import type { Ledger } from "./ledger.ts";
import { formatBaseUnits, rescaleExact } from "./units.ts";

export type Classification = "top_up" | "gateway_deposit" | "gateway_withdrawal" | "unexpected_outbound" | "unrelated";

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface WatchedAddresses {
  agent: string;
  gatewayWallet: string;
  gatewayMinter: string;
}

/** How a native USDC movement relates to the agent wallet. */
export function classify(from: string, to: string, w: WatchedAddresses): Classification {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  const agent = w.agent.toLowerCase();
  if (f === agent && t === agent) return "unrelated";
  if (t === agent) return f === ZERO || f === w.gatewayMinter.toLowerCase() ? "gateway_withdrawal" : "top_up";
  if (f === agent) return t === w.gatewayWallet.toLowerCase() ? "gateway_deposit" : "unexpected_outbound";
  return "unrelated";
}

export function signQuickNode(token: string, nonce: string, timestamp: string, payload: string): string {
  return createHmac("sha256", Buffer.from(token)).update(Buffer.from(nonce + timestamp + payload)).digest("hex");
}

export function verifyQuickNodeSignature(token: string, nonce: string, timestamp: string, payload: string, signature: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signQuickNode(token, nonce, timestamp, payload), "hex"), Buffer.from(signature, "hex"));
}

interface Movement {
  canonical_id: string;
  block_number: string;
  transaction_hash: string;
  log_index: string;
  from_address: string;
  to_address: string;
  amount_raw: string;
  decimals: number;
}

function isMovement(m: unknown, chainId: number): m is Movement {
  if (!m || typeof m !== "object") return false;
  const x = m as Record<string, unknown>;
  const digits = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);
  const addr = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
  return (
    typeof x.canonical_id === "string" &&
    x.canonical_id === `${chainId}:${String(x.transaction_hash)}:${String(x.log_index)}` &&
    typeof x.transaction_hash === "string" && /^0x[0-9a-f]{64}$/.test(x.transaction_hash) &&
    digits(x.block_number) && digits(x.log_index) && digits(x.amount_raw) &&
    addr(x.from_address) && addr(x.to_address) &&
    Number.isInteger(x.decimals) && (x.decimals as number) >= 0 && (x.decimals as number) <= 36
  );
}

const NATIVE_USDC_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const isRawLog = (v: unknown): v is { address: string; topics: unknown[]; data: string } & Record<string, unknown> =>
  !!v && typeof v === "object" && typeof (v as Record<string, unknown>).address === "string" &&
  Array.isArray((v as Record<string, unknown>).topics) && typeof (v as Record<string, unknown>).data === "string";

interface Extracted {
  movements: unknown[];
  rawLogs: Array<Record<string, unknown>>;
}

/**
 * Finds filter output ({movements:[…]}) or raw logs anywhere in a VERIFIED body (bounded depth),
 * so a wrapper such as {data:[{movements}], metadata} or an unfiltered Stream is never silently dropped.
 */
export function extractFromBody(body: unknown, out: Extracted = { movements: [], rawLogs: [] }, depth = 0): Extracted {
  if (depth > 8 || body === null || typeof body !== "object") return out;
  if (Array.isArray(body)) {
    for (const v of body) extractFromBody(v, out, depth + 1);
    return out;
  }
  if (isRawLog(body)) {
    out.rawLogs.push(body);
    return out;
  }
  const o = body as Record<string, unknown>;
  if (Array.isArray(o.movements)) {
    out.movements.push(...o.movements);
    return out;
  }
  for (const [k, v] of Object.entries(o)) if (k !== "metadata") extractFromBody(v, out, depth + 1);
  return out;
}

/** Server-side copy of streams/filter.template.js rules, used only when the Stream delivers raw logs. */
export function movementsFromRawLogs(logs: Array<Record<string, unknown>>, chainId: number, watched: readonly string[]): Movement[] {
  const w = watched.map((a) => a.toLowerCase());
  const hex = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v).toString(10) : null);
  const addr = (t: unknown) => (typeof t === "string" && BYTES32.test(t) ? `0x${t.slice(-40).toLowerCase()}` : null);
  const out: Movement[] = [];
  for (const log of logs) {
    if (log.removed === true || String(log.address).toLowerCase() !== NATIVE_USDC_EMITTER) continue;
    const topics = log.topics as unknown[];
    if (topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = addr(topics[1]);
    const to = addr(topics[2]);
    if (!from || !to || (!w.includes(from) && !w.includes(to))) continue;
    const amount = BYTES32.test(String(log.data)) ? hex(log.data) : null;
    const block = hex(log.blockNumber);
    const logIndex = hex(log.logIndex);
    const tx = typeof log.transactionHash === "string" && BYTES32.test(log.transactionHash) ? log.transactionHash.toLowerCase() : null;
    if (!amount || !block || logIndex === null || !tx) continue;
    out.push({
      canonical_id: `${chainId}:${tx}:${logIndex}`, block_number: block, transaction_hash: tx, log_index: logIndex,
      from_address: from, to_address: to, amount_raw: amount, decimals: 18,
    });
  }
  return out;
}

/** Structure only (keys, types, lengths), never values: safe to log. */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return depth > 3 ? `array(${v.length})` : `array(${v.length})${v.length ? `[${shapeOf(v[0], depth + 1)}]` : ""}`;
  if (typeof v !== "object") return typeof v;
  if (isRawLog(v)) return "log";
  const keys = Object.keys(v as object);
  if (depth > 3) return `object(${keys.length} keys)`;
  return `{${keys.slice(0, 8).map((k) => `${k}:${shapeOf((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}${keys.length > 8 ? ",…" : ""}}`;
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "Delivery too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface StreamsOptions extends WatchedAddresses {
  db: DB;
  ledger: Ledger;
  auth: Auth;
  securityToken?: string;
  chainId: number;
  /** Decimals of Arc's 6-decimal USDC view, for the exact-conversion column. */
  usdcDecimals: number;
  maxSkewSeconds?: number;
  now?: () => number;
  log?: (line: string) => void;
  explorerTx?: (hash: string) => string;
}

export function registerStreamsWebhook(router: Router, o: StreamsOptions): void {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const skew = o.maxSkewSeconds ?? 300;
  const watched: WatchedAddresses = { agent: o.agent, gatewayWallet: o.gatewayWallet, gatewayMinter: o.gatewayMinter };

  const seen = o.db.prepare("SELECT 1 FROM webhook_deliveries WHERE nonce = ?");
  const insertDelivery = o.db.prepare(
    "INSERT INTO webhook_deliveries (nonce, received_at, signed_at, movements, inserted) VALUES (?, ?, ?, ?, ?)",
  );
  const insertMovement = o.db.prepare(`
    INSERT OR IGNORE INTO chain_movements (canonical_id, block_number, tx_hash, log_index, from_address, to_address,
      amount_raw, raw_decimals, amount_usdc, classification, delivery_nonce, observed_at)
    VALUES (@id, @block, @tx, @logIndex, @from, @to, @raw, @decimals, @usdc, @cls, @nonce, @t)`);
  const recent = o.db.prepare("SELECT * FROM chain_movements ORDER BY block_number DESC, log_index DESC LIMIT ?");
  // Replay protection only needs nonces inside the freshness window; older timestamps are refused as stale anyway.
  const pruneNonces = o.db.prepare("DELETE FROM webhook_deliveries WHERE received_at < ?");
  let sincePrune = 0;

  // Quiet-period bookkeeping: one summary line every 5 minutes instead of a line per empty delivery.
  const stats = { deliveries: 0, withMovements: 0, rawLogDeliveries: 0, since: now() };
  let lastShape = "";
  let shapesLogged = 0;
  const summaryTimer = setInterval(() => {
    if (stats.deliveries) {
      log(`[streams] last 5 min: ${stats.deliveries} verified deliveries, ${stats.withMovements} with movements, ${stats.rawLogDeliveries} carrying raw logs`);
    }
    Object.assign(stats, { deliveries: 0, withMovements: 0, rawLogDeliveries: 0, since: now() });
  }, 5 * 60_000);
  summaryTimer.unref();

  const ingest = o.db.transaction((nonce: string, signedAt: number, movements: Movement[]) => {
    if (seen.get(nonce)) return { duplicate: true, inserted: 0, anomalies: [] as Movement[] };
    const t = now();
    let inserted = 0;
    const anomalies: Movement[] = [];
    for (const m of movements) {
      const cls = classify(m.from_address, m.to_address, watched);
      let usdc: bigint | null = null;
      try {
        usdc = rescaleExact(BigInt(m.amount_raw), m.decimals, o.usdcDecimals);
      } catch {
        usdc = null; // not exactly representable in 6 decimals; amount_raw keeps the exact value
      }
      const r = insertMovement.run({
        id: m.canonical_id, block: Number(m.block_number), tx: m.transaction_hash, logIndex: Number(m.log_index),
        from: m.from_address, to: m.to_address, raw: m.amount_raw, decimals: m.decimals, usdc, cls, nonce, t,
      });
      if (r.changes === 1) {
        inserted++;
        if (cls === "unexpected_outbound") anomalies.push(m);
      }
    }
    insertDelivery.run(nonce, t, signedAt * 1000, movements.length, inserted);
    if (++sincePrune >= 500) {
      sincePrune = 0;
      pruneNonces.run(t - (2 * skew + 60) * 1000);
    }
    if (anomalies.length) {
      const a = anomalies[0];
      o.ledger.setFrozen(
        true,
        `Unexpected outbound transfer of ${formatBaseUnits(BigInt(a.amount_raw), a.decimals)} USDC from the agent wallet to ${a.to_address} (tx ${a.transaction_hash})`,
      );
    }
    return { duplicate: false, inserted, anomalies };
  });

  router.add("POST", "/webhooks/quicknode", async ({ req, res }) => {
    if (!o.securityToken) return sendJson(res, 503, { error: "streams_not_configured" });
    const nonce = req.headers["x-qn-nonce"];
    const timestamp = req.headers["x-qn-timestamp"];
    const signature = req.headers["x-qn-signature"];
    if (typeof nonce !== "string" || typeof timestamp !== "string" || typeof signature !== "string" || !nonce || !timestamp) {
      throw new HttpError(401, "missing_signature", "X-QN-Nonce, X-QN-Timestamp and X-QN-Signature are required");
    }
    let raw = await readRaw(req);
    if (String(req.headers["content-encoding"] ?? "").toLowerCase().includes("gzip")) {
      try {
        raw = gunzipSync(raw);
      } catch {
        throw new HttpError(400, "bad_gzip", "Body is not valid gzip");
      }
    }
    const payload = raw.toString("utf8");
    if (!verifyQuickNodeSignature(o.securityToken, nonce, timestamp, payload, signature)) {
      log(`[streams] rejected delivery: invalid signature (nonce ${nonce.slice(0, 12)})`);
      throw new HttpError(401, "invalid_signature", "Signature does not match");
    }
    const signedAt = Number(timestamp);
    if (!Number.isInteger(signedAt) || Math.abs(now() / 1000 - signedAt) > skew) {
      log(`[streams] rejected delivery: timestamp outside ±${skew}s`);
      throw new HttpError(401, "stale_signature", `Timestamp outside ±${skew}s`);
    }

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      throw new HttpError(400, "invalid_json", "Signed body is not JSON");
    }
    // Everything below runs only on a verified, fresh body.
    const shape = shapeOf(body);
    if (shape !== lastShape && shapesLogged < 20) {
      lastShape = shape;
      shapesLogged++;
      log(`[streams] verified payload shape: ${shape.slice(0, 400)}`);
    }
    const found = extractFromBody(body);
    const fromFilter = found.movements.filter((m): m is Movement => isMovement(m, o.chainId));
    if (fromFilter.length !== found.movements.length) {
      log(`[streams] ignored ${found.movements.length - fromFilter.length} malformed or foreign-chain movement(s)`);
    }
    const fromRaw = found.rawLogs.length ? movementsFromRawLogs(found.rawLogs, o.chainId, [o.agent]) : [];
    if (found.rawLogs.length) {
      stats.rawLogDeliveries++;
      if (stats.rawLogDeliveries === 1) {
        log(`[streams] WARNING: Stream is delivering unfiltered logs (${found.rawLogs.length} in this batch); applying the filter rules server-side. Paste backend/streams/filter.js into the Stream.`);
      }
    }
    const movements = [...fromFilter, ...fromRaw];

    const r = ingest.immediate(nonce, signedAt, movements);
    stats.deliveries++;
    if (movements.length || r.duplicate) {
      stats.withMovements += movements.length ? 1 : 0;
      log(`[streams] delivery ${nonce.slice(0, 12)}: ${movements.length} movement(s)${fromRaw.length ? ` (${fromRaw.length} from raw logs)` : ""}, ${r.inserted} new${r.duplicate ? " (duplicate delivery)" : ""}${r.anomalies.length ? " -> FROZE spending" : ""}`);
    }
    sendJson(res, 200, { ok: true, duplicate: r.duplicate, received: movements.length, inserted: r.inserted, frozen: r.anomalies.length > 0 });
  });

  router.add("GET", "/api/chain/movements", ({ req, res, url }) => {
    o.auth.require(req, "agent");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
    const rows = recent.all(limit) as Array<Record<string, string | number | null>>;
    sendJson(res, 200, {
      movements: rows.map((r) => ({
        canonicalId: r.canonical_id,
        block: r.block_number,
        txHash: r.tx_hash,
        logIndex: r.log_index,
        from: r.from_address,
        to: r.to_address,
        amountUsdc: formatBaseUnits(BigInt(r.amount_raw as string), r.raw_decimals as number),
        classification: r.classification,
        observedAt: r.observed_at,
        explorer: o.explorerTx ? o.explorerTx(String(r.tx_hash)) : undefined,
      })),
    });
  });
}
