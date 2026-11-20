import { AlertTriangle, BookOpen, Check, ExternalLink, Hand, Inbox, Receipt, TrendingUp, X } from "lucide-react";
import { EXPLORER_TX_URL } from "../config";
import { formatPct } from "../backend";
import type { Payment } from "../types";
import { PanelTitle } from "./Card";
import { usd } from "../format";

// Every purchase the backend reports, newest first: paid ones, ones in flight or waiting for a
// person, and ones that were not charged (with the backend's reason). Amounts are exact labels.
export function PaymentFeed({ payments, title = "Payments" }: { payments: Payment[]; title?: string }) {
  const paid = payments.filter((p) => p.status === "confirmed");
  const total = paid.reduce((s, p) => s + p.amount, 0);

  return (
    <section className="@container flex h-full min-h-[320px] flex-col overflow-hidden rounded-[22px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 pb-4 pt-5">
        <PanelTitle icon={<Receipt size={17} />}>{title}</PanelTitle>
        {paid.length > 0 && (
          <span className="text-sm text-ink-soft">
            {paid.length} paid, <span className="font-semibold text-ink">{usd(total)} USDC</span> total
          </span>
        )}
      </div>

      {payments.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 text-center">
          <span className="mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-paper text-muted">
            <Inbox size={26} />
          </span>
          <p className="text-[15px] font-medium">No purchases yet</p>
          <p className="max-w-xs text-sm leading-relaxed text-ink-soft">
            When your agent buys data, each USDC payment shows up here and settles live on Arc Testnet.
          </p>
        </div>
      ) : (
        <ul className="flex-1 divide-y divide-line overflow-y-auto">
          {payments.map((p) => (
            <PaymentRow key={p.id} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PaymentRow({ p }: { p: Payment }) {
  const pending = p.status === "pending";
  const charged = p.status === "confirmed" || p.status === "pending" || p.status === "review";
  return (
    <li className="row-in relative">
      {/* Keyed by status so the flash replays the moment a payment settles. */}
      <div key={p.status} className={`px-6 py-4 ${p.status === "confirmed" ? "settle-flash" : ""}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <SellerIcon seller={p.seller} />
            <div className="min-w-0">
              <div className="truncate text-[16px] font-semibold">{p.itemTitle ?? p.seller}</div>
              <div className="mt-0.5 truncate text-sm text-muted">
                {p.itemTitle ? `${p.seller} · ` : ""}
                {new Date(p.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="flex items-baseline justify-end gap-1.5">
              <span
                className={`text-[22px] font-semibold tracking-[-0.02em] ${
                  !charged ? "text-muted line-through decoration-1" : pending ? "text-ink-soft" : "text-ink"
                }`}
              >
                {charged ? "−" : ""}
                {p.amountLabel ?? usd(p.amount)}
              </span>
              <UsdcTag />
            </div>
            <div className="mt-1 flex justify-end">
              <StatusChip status={p.status} settled={Boolean(p.txHash)} />
            </div>
          </div>
        </div>

        {(p.status === "not_charged" || p.status === "review" || p.status === "awaiting") && reasonLine(p) && (
          <p className={`mt-2 text-sm ${p.status === "review" ? "text-stop" : "text-ink-soft"}`}>{reasonLine(p)}</p>
        )}

        {p.data && (
          <div className="msg-in mt-3 flex items-center justify-between gap-4 rounded-xl bg-paper px-4 py-2.5">
            <span className="text-[15px] leading-snug text-ink">{p.data.market}</span>
            <span className="shrink-0 text-right">
              <span className="block text-[20px] font-bold leading-none text-pine">{formatPct(p.data.yesPrice)}</span>
              <span className="text-xs text-ink-soft">{p.data.yesLabel ?? "chance yes"}</span>
            </span>
          </div>
        )}

        {p.txHash ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
            <span className="flex items-baseline gap-2 text-ink-soft">
              Arc tx
              <span className="font-mono text-[13px] text-ink" title={p.txHash}>
                {p.txHash.slice(0, 10)}…{p.txHash.slice(-8)}
              </span>
            </span>
            <a
              href={EXPLORER_TX_URL(p.txHash)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-medium text-usdc underline-offset-4 hover:underline"
            >
              View on Arc explorer <ExternalLink size={14} />
            </a>
          </div>
        ) : (
          p.status === "confirmed" && (
            <p className="mt-3 text-sm text-ink-soft">Paid through Circle Gateway. The batch settles onchain in about 6–13 minutes; the Arc tx appears here then.</p>
          )
        )}
      </div>

      {pending && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-usdc-soft" aria-hidden="true">
          <div className="sweep h-full w-2/5 bg-usdc" />
        </div>
      )}
    </li>
  );
}

// Order-book sellers get a book; everything else is market data.
function SellerIcon({ seller }: { seller: string }) {
  const Icon = /book/i.test(seller) ? BookOpen : TrendingUp;
  return (
    <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-paper text-ink-soft @md:flex">
      <Icon size={19} />
    </span>
  );
}

function UsdcTag() {
  return (
    <span className="flex items-center gap-1 self-center rounded-full bg-usdc-soft px-2 py-0.5 text-xs font-semibold text-usdc">
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-usdc text-[9px] font-bold text-white">$</span>
      USDC
    </span>
  );
}

// What happened to a purchase that wasn't charged; shown before the backend's reason.
const NOT_CHARGED_LABEL: Record<string, string> = {
  blocked: "Blocked",
  declined: "Declined",
  approval_expired: "Approval expired",
  aborted: "Stopped before paying",
  rejected: "Rejected by Gateway",
  expired: "Expired unsettled",
};

/** "Blocked: Seller is not on the allowlist" (skips the prefix when the reason already says it). */
function reasonLine(p: Payment): string | null {
  const label = p.status === "not_charged" ? NOT_CHARGED_LABEL[p.state ?? ""] : null;
  if (!p.reason) return label;
  if (!label || p.reason.toLowerCase().startsWith(label.toLowerCase())) return p.reason;
  return `${label}: ${p.reason}`;
}

function StatusChip({ status, settled }: { status: Payment["status"]; settled: boolean }) {
  if (status === "confirmed" && settled)
    return (
      <span className="chip-pop flex items-center gap-1 rounded-full bg-pine-soft px-2.5 py-0.5 text-[13px] font-semibold text-pine">
        <Check size={14} strokeWidth={3} /> Settled on Arc
      </span>
    );
  if (status === "confirmed")
    return (
      <span className="chip-pop flex items-center gap-1.5 rounded-full bg-pine-soft px-2.5 py-0.5 text-[13px] font-semibold text-pine">
        <Check size={14} strokeWidth={3} /> Paid · settling on Arc
      </span>
    );
  if (status === "not_charged")
    return (
      <span className="flex items-center gap-1 rounded-full bg-paper px-2.5 py-0.5 text-[13px] font-semibold text-ink-soft ring-1 ring-line">
        <X size={14} strokeWidth={3} /> Not charged
      </span>
    );
  if (status === "awaiting")
    return (
      <span className="flex items-center gap-1 rounded-full bg-hold-soft px-2.5 py-0.5 text-[13px] font-semibold text-[#8a5d08]">
        <Hand size={14} /> Waiting for approval
      </span>
    );
  if (status === "review")
    return (
      <span className="flex items-center gap-1 rounded-full bg-[#f7e3df] px-2.5 py-0.5 text-[13px] font-semibold text-stop">
        <AlertTriangle size={14} /> Held for review
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-usdc-soft px-2.5 py-0.5 text-[13px] font-semibold text-usdc">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-usdc" /> Confirming payment…
    </span>
  );
}
