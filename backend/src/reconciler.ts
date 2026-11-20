/**
 * Moves purchases whose outcome is not final toward a final state, using Gateway as the
 * source of truth. It never releases funds on a timeout alone:
 *   awaiting_approval past its window   -> approval_expired
 *   reserved, stale, never signed       -> aborted (released; nothing was sent)
 *   signed, stale (process interrupted) -> pending_unknown
 *   pending_unknown: transfer found by nonce -> accepted (or needs_review if Gateway says failed)
 *                    nothing found and now > validBefore + margin -> expired (released)
 *   accepted: Gateway completed with txHash -> settled; failed -> needs_review
 */
import type { Ledger, Purchase } from "./ledger.ts";

export interface GatewayTransfer {
  id: string;
  status: string;
  txHash: string | null;
}

export interface GatewayStatusApi {
  getTransferById(id: string): Promise<GatewayTransfer>;
  findByNonce(nonce: string): Promise<GatewayTransfer | undefined>;
}

export interface ReconcilerOptions {
  now: () => number;
  intervalMs: number;
  staleReservedMs: number;
  staleSignedMs: number;
  /** Extra time after validBefore before an unseen authorization is treated as dead. */
  expiryMarginMs: number;
  batch: number;
  log: (line: string) => void;
}

export function createReconciler(ledger: Ledger, gateway: GatewayStatusApi, overrides: Partial<ReconcilerOptions> = {}) {
  const o: ReconcilerOptions = {
    now: Date.now,
    intervalMs: 30_000,
    staleReservedMs: 2 * 60_000,
    staleSignedMs: 2 * 60_000,
    expiryMarginMs: 15 * 60_000,
    batch: 25,
    log: (l) => console.log(l),
    ...overrides,
  };

  async function step(p: Purchase): Promise<void> {
    const t = o.now();
    switch (p.state) {
      case "awaiting_approval":
        if (p.approvalExpiresAt !== null && t > p.approvalExpiresAt) {
          ledger.transition(p.id, ["awaiting_approval"], "approval_expired", { reason: "The approval window passed" });
        }
        return;
      case "reserved":
        if (t - p.updatedAt > o.staleReservedMs) {
          ledger.transition(p.id, ["reserved"], "aborted", { reason: "Interrupted before signing; nothing was sent" });
        }
        return;
      case "signed":
        if (t - p.updatedAt > o.staleSignedMs) {
          ledger.transition(p.id, ["signed"], "pending_unknown", { reason: "Interrupted after signing; outcome unconfirmed" });
        }
        return;
      case "pending_unknown": {
        if (!p.nonce) return;
        const found = await gateway.findByNonce(p.nonce);
        if (found) {
          const failed = found.status === "failed";
          ledger.transition(p.id, ["pending_unknown"], failed ? "needs_review" : "accepted", {
            reason: failed ? "Gateway reports the transfer failed" : `Gateway has the transfer (${found.status})`,
            gatewayTransferId: found.id,
          });
        } else if (p.validBefore !== null && t > p.validBefore * 1000 + o.expiryMarginMs) {
          ledger.transition(p.id, ["pending_unknown"], "expired", {
            reason: "Gateway never received it and the authorization has expired",
          });
        }
        return;
      }
      case "accepted": {
        if (!p.gatewayTransferId) return;
        const tr = await gateway.getTransferById(p.gatewayTransferId);
        if (tr.status === "completed" && tr.txHash) {
          ledger.transition(p.id, ["accepted"], "settled", { reason: "Settled onchain", settlementTx: tr.txHash });
        } else if (tr.status === "failed") {
          ledger.transition(p.id, ["accepted"], "needs_review", { reason: "Gateway reports the transfer failed" });
        }
        return;
      }
      default:
        return;
    }
  }

  async function reconcileOnce(): Promise<number> {
    const open = ledger.listByState(["awaiting_approval", "reserved", "signed", "pending_unknown", "accepted"], o.batch);
    let errors = 0;
    for (const p of open) {
      try {
        await step(p);
      } catch (err) {
        errors++;
        o.log(`[reconciler] ${p.id} (${p.state}): ${(err as Error).message}`);
      }
    }
    return errors;
  }

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  async function loop() {
    if (stopped) return;
    await reconcileOnce().catch((err) => o.log(`[reconciler] ${(err as Error).message}`));
    if (!stopped) timer = setTimeout(loop, o.intervalMs);
  }

  return {
    reconcileOnce,
    start() {
      stopped = false;
      void loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
