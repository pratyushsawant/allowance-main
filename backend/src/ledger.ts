/**
 * Purchases ledger: the only place budget is reserved or released.
 *
 * - Every write runs in a BEGIN IMMEDIATE transaction (SQLite's single write lock), so the
 *   policy check and the reservation it authorizes are atomic: concurrent requests cannot
 *   both see the same remaining budget.
 * - idempotency_key is UNIQUE; a repeated key returns the stored purchase and never pays again.
 * - State changes go through transition(), which checks the expected current state inside the
 *   transaction, so a purchase cannot be signed, approved or settled twice.
 * - Amounts are INTEGER base units, read back as BigInt (safeIntegers).
 */
import { randomUUID } from "node:crypto";
import type { DB } from "./db.ts";
import { evaluate, type Decision, type PolicyConfig, type PolicyInputs, type Quote } from "./policy.ts";

export type PurchaseState =
  | "blocked" // policy said no; nothing reserved, nothing signed
  | "awaiting_approval" // over the auto-approve limit; nothing reserved yet
  | "declined" // a person said no
  | "approval_expired"
  | "reserved" // budget held; not yet signed
  | "aborted" // released before anything was signed or sent
  | "signed" // write-ahead: authorization created and about to be sent
  | "accepted" // seller returned 2xx after Gateway accepted it
  | "settled" // Gateway reports completed with a txHash
  | "rejected" // Gateway refused it for a reason that makes it permanently unusable; released
  | "pending_unknown" // outcome unknown; held until reconciled
  | "expired" // never settled and past validBefore; released
  | "needs_review"; // Gateway reported a failure after acceptance; held for a person

/** States whose amount counts against the budget. */
export const HOLDING_STATES: readonly PurchaseState[] = [
  "reserved", "signed", "accepted", "settled", "pending_unknown", "needs_review",
];
/** Held here but not yet debited by Gateway (Gateway lowers `available` when it accepts an authorization). */
const NOT_YET_DEBITED: readonly PurchaseState[] = ["reserved", "signed", "pending_unknown"];

export interface Purchase {
  id: string;
  idempotencyKey: string;
  itemId: string;
  sellerId: string;
  resourceUrl: string;
  payTo: string;
  asset: string;
  network: string;
  amount: bigint;
  budgetDay: string;
  state: PurchaseState;
  reason: string | null;
  nonce: string | null;
  validBefore: number | null;
  gatewayTransferId: string | null;
  settlementTx: string | null;
  result: unknown;
  approvalExpiresAt: number | null;
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TransitionPatch {
  reason?: string;
  nonce?: string;
  validBefore?: number;
  gatewayTransferId?: string;
  settlementTx?: string;
  result?: unknown;
}

export interface ReserveInput {
  idempotencyKey: string;
  itemId: string;
  sellerId: string;
  resourceUrl: string;
  quote: Quote;
  /** Gateway `available` for the payer, fetched just before this call. */
  gatewayAvailable: bigint;
}

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export function budgetDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

type Raw = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toPurchase(r: Raw): Purchase {
  return {
    id: r.id as string,
    idempotencyKey: r.idempotency_key as string,
    itemId: r.item_id as string,
    sellerId: r.seller_id as string,
    resourceUrl: r.resource_url as string,
    payTo: r.pay_to as string,
    asset: r.asset as string,
    network: r.network as string,
    amount: r.amount as bigint,
    budgetDay: r.budget_day as string,
    state: r.state as PurchaseState,
    reason: (r.reason as string | null) ?? null,
    nonce: (r.nonce as string | null) ?? null,
    validBefore: num(r.valid_before),
    gatewayTransferId: (r.gateway_transfer_id as string | null) ?? null,
    settlementTx: (r.settlement_tx as string | null) ?? null,
    result: r.result_json ? JSON.parse(r.result_json as string) : null,
    approvalExpiresAt: num(r.approval_expires_at),
    approvedAt: num(r.approved_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const sqlList = (states: readonly PurchaseState[]) => `(${states.map((s) => `'${s}'`).join(", ")})`;

export interface LedgerOptions {
  now: () => number;
  /** How long a person has to approve a held purchase. */
  approvalTtlMs: number;
}

export function createLedger(db: DB, config: PolicyConfig, overrides: Partial<LedgerOptions> = {}) {
  const now = overrides.now ?? Date.now;
  const approvalTtlMs = overrides.approvalTtlMs ?? 10 * 60_000;
  const big = (sql: string) => db.prepare(sql).safeIntegers(true);

  const byId = big("SELECT * FROM purchases WHERE id = ?");
  const byKey = big("SELECT * FROM purchases WHERE idempotency_key = ?");
  const committedToday = big(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM purchases WHERE budget_day = ? AND state IN ${sqlList(HOLDING_STATES)}`,
  );
  const notYetDebited = big(`SELECT COALESCE(SUM(amount), 0) AS total FROM purchases WHERE state IN ${sqlList(NOT_YET_DEBITED)}`);
  const policyRow = db.prepare("SELECT frozen, frozen_reason FROM policy_state WHERE id = 1");
  const insert = db.prepare(`
    INSERT INTO purchases (id, idempotency_key, item_id, seller_id, resource_url, pay_to, asset, network, amount,
      budget_day, state, reason, approval_expires_at, created_at, updated_at)
    VALUES (@id, @key, @itemId, @sellerId, @resourceUrl, @payTo, @asset, @network, @amount,
      @day, @state, @reason, @approvalExpiresAt, @t, @t)`);
  const update = db.prepare(`
    UPDATE purchases SET state = @to,
      reason = COALESCE(@reason, reason), nonce = COALESCE(@nonce, nonce),
      valid_before = COALESCE(@validBefore, valid_before),
      gateway_transfer_id = COALESCE(@gatewayTransferId, gateway_transfer_id),
      settlement_tx = COALESCE(@settlementTx, settlement_tx), result_json = COALESCE(@result, result_json),
      approved_at = COALESCE(@approvedAt, approved_at), budget_day = COALESCE(@day, budget_day), updated_at = @t
    WHERE id = @id AND state = @from`);
  const audit = db.prepare("INSERT INTO purchase_events (purchase_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)");
  const setFrozenStmt = db.prepare("UPDATE policy_state SET frozen = ?, frozen_reason = ?, updated_at = ? WHERE id = 1");

  function get(id: string): Purchase | undefined {
    const r = byId.get(id) as Raw | undefined;
    return r ? toPurchase(r) : undefined;
  }
  function mustGet(id: string): Purchase {
    const p = get(id);
    if (!p) throw new LedgerError("not_found", "No such purchase");
    return p;
  }
  function getByKey(key: string): Purchase | undefined {
    const r = byKey.get(key) as Raw | undefined;
    return r ? toPurchase(r) : undefined;
  }

  function inputs(gatewayAvailable: bigint, day: string): PolicyInputs {
    const p = policyRow.get() as { frozen: number; frozen_reason: string | null };
    return {
      frozen: p.frozen === 1,
      frozenReason: p.frozen_reason,
      committedToday: (committedToday.get(day) as { total: bigint }).total,
      availableFunds: gatewayAvailable - (notYetDebited.get() as { total: bigint }).total,
    };
  }

  function write(p: Purchase, to: PurchaseState, patch: TransitionPatch & { approvedAt?: number; day?: string } = {}): Purchase {
    const t = now();
    const changes = update.run({
      id: p.id, from: p.state, to, t,
      reason: patch.reason ?? null, nonce: patch.nonce ?? null, validBefore: patch.validBefore ?? null,
      gatewayTransferId: patch.gatewayTransferId ?? null, settlementTx: patch.settlementTx ?? null,
      result: patch.result === undefined ? null : JSON.stringify(patch.result),
      approvedAt: patch.approvedAt ?? null, day: patch.day ?? null,
    }).changes;
    if (changes !== 1) throw new LedgerError("conflict", `Purchase changed concurrently (expected ${p.state})`);
    audit.run(p.id, t, p.state, to, patch.reason ?? null);
    return mustGet(p.id);
  }

  const reserveTx = db.transaction((input: ReserveInput): { purchase: Purchase; created: boolean; decision?: Decision } => {
    const existing = getByKey(input.idempotencyKey);
    if (existing) return { purchase: existing, created: false };
    const t = now();
    const day = budgetDay(t, config.timeZone);
    const decision = evaluate(input.quote, inputs(input.gatewayAvailable, day), config);
    const state: PurchaseState =
      decision.kind === "allow" ? "reserved" : decision.kind === "needs_approval" ? "awaiting_approval" : "blocked";
    const id = randomUUID();
    insert.run({
      id, key: input.idempotencyKey, itemId: input.itemId, sellerId: input.sellerId, resourceUrl: input.resourceUrl,
      payTo: input.quote.payTo, asset: input.quote.asset, network: input.quote.network, amount: input.quote.amount,
      day, state, reason: decision.reason, approvalExpiresAt: state === "awaiting_approval" ? t + approvalTtlMs : null, t,
    });
    audit.run(id, t, null, state, decision.reason);
    return { purchase: mustGet(id), created: true, decision };
  });

  const approveTx = db.transaction((id: string, gatewayAvailable: bigint): Purchase => {
    const p = mustGet(id);
    if (p.state !== "awaiting_approval") throw new LedgerError("invalid_state", `Purchase is ${p.state}, not awaiting approval`);
    const t = now();
    if (p.approvalExpiresAt !== null && t > p.approvalExpiresAt) {
      return write(p, "approval_expired", { reason: "The approval window passed" });
    }
    // Re-run the whole policy now: limits, the freeze switch or the day may have changed since the request.
    const day = budgetDay(t, config.timeZone);
    const quote: Quote = { payTo: p.payTo, network: p.network, asset: p.asset, amount: p.amount };
    const decision = evaluate(quote, inputs(gatewayAvailable, day), config, { humanApproved: true });
    return decision.kind === "allow"
      ? write(p, "reserved", { reason: decision.reason, approvedAt: t, day })
      : write(p, "blocked", { reason: `Approved, but ${decision.reason}` });
  });

  const transitionTx = db.transaction(
    (id: string, from: readonly PurchaseState[], to: PurchaseState, patch: TransitionPatch): Purchase => {
      const p = mustGet(id);
      if (!from.includes(p.state)) throw new LedgerError("invalid_state", `Cannot move a ${p.state} purchase to ${to}`);
      return write(p, to, patch);
    },
  );

  return {
    get,
    getByKey,
    mustGet,
    /** Records the purchase and the policy decision; reserves budget when the decision is allow. */
    reserve: (input: ReserveInput) => reserveTx.immediate(input),
    approve: (id: string, gatewayAvailable: bigint) => approveTx.immediate(id, gatewayAvailable),
    decline: (id: string, reason = "Declined by a person") => transitionTx.immediate(id, ["awaiting_approval"], "declined", { reason }),
    transition: (id: string, from: readonly PurchaseState[], to: PurchaseState, patch: TransitionPatch = {}) =>
      transitionTx.immediate(id, from, to, patch),
    listByState: (states: readonly PurchaseState[], limit = 50): Purchase[] =>
      (big(`SELECT * FROM purchases WHERE state IN ${sqlList(states)} ORDER BY created_at LIMIT ?`).all(limit) as Raw[]).map(toPurchase),
    recent: (limit = 20): Purchase[] =>
      (big("SELECT * FROM purchases ORDER BY created_at DESC LIMIT ?").all(limit) as Raw[]).map(toPurchase),
    setFrozen(frozen: boolean, reason: string | null): void {
      setFrozenStmt.run(frozen ? 1 : 0, frozen ? reason : null, now());
    },
    budget(gatewayAvailable?: bigint) {
      const day = budgetDay(now(), config.timeZone);
      const s = inputs(gatewayAvailable ?? 0n, day);
      return {
        day,
        timeZone: config.timeZone,
        frozen: s.frozen,
        frozenReason: s.frozenReason,
        dailyCap: config.dailyCap,
        committedToday: s.committedToday,
        remainingToday: config.dailyCap > s.committedToday ? config.dailyCap - s.committedToday : 0n,
        autoApproveMax: config.autoApproveMax,
        perCallMax: config.perCallMax,
        gatewayAvailable: gatewayAvailable ?? null,
        availableFunds: gatewayAvailable === undefined ? null : s.availableFunds,
      };
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;
