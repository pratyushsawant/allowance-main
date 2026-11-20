import { Wallet } from "lucide-react";
import type { Budget, Payment } from "../types";
import { Card } from "./Card";
import { usd } from "../format";

/** YYYY-MM-DD of `ms` in `timeZone` (en-CA formats dates that way). */
const dayIn = (ms: number, timeZone: string) => new Date(ms).toLocaleDateString("en-CA", { timeZone });

// Today's allowance. With the real backend every number is the backend's own (committed = paid +
// held, in its budget time zone); the bar shows today's charged purchases, one segment each.
// Without a backend figure (mock mode, or before login) it falls back to the rules and the list.
export function BudgetMeter({ spent, budget, dailyCap, payments }: { spent: number; budget: Budget | null; dailyCap: number; payments: Payment[] }) {
  const cap = budget?.dailyCap ?? dailyCap;
  const committed = budget?.spentToday ?? spent;
  const left = budget?.remainingToday ?? Math.max(0, cap - committed);
  const isToday = budget
    ? (p: Payment) => dayIn(p.timestamp, budget.timeZone) === budget.day
    : (p: Payment) => p.timestamp >= new Date().setHours(0, 0, 0, 0);
  const today = payments
    .filter((p) => (p.status === "confirmed" || p.status === "pending" || p.status === "review") && isToday(p))
    .slice()
    .reverse(); // oldest first, left to right
  const paidCount = today.filter((p) => p.status === "confirmed").length;
  const pct = cap > 0 ? committed / cap : 0;
  const fill = pct > 0.9 ? "bg-stop" : pct > 0.7 ? "bg-hold" : "bg-pine";
  const pctLabel = `${Math.round(pct * 1000) / 10}%`;

  return (
    <Card title="Today's allowance" icon={<Wallet size={17} />} aside={`${budget?.dailyCapLabel ?? usd(cap)} USDC a day`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[44px] font-bold leading-none tracking-[-0.03em]">{budget?.remainingTodayLabel ?? usd(left)}</span>
        <span className="text-[15px] font-medium text-ink-soft">USDC left today</span>
      </div>

      <div
        className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-paper"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={committed}
        aria-label="Committed today"
      >
        {cap > 0 &&
          today.map((p) => (
            <div
              key={p.id}
              title={`${p.itemTitle ?? p.seller}: ${p.amountLabel ?? usd(p.amount)} USDC`}
              className={`h-full shrink-0 transition-[width] duration-500 first:rounded-l-full ${p.status === "confirmed" ? fill : "bg-usdc/40"}`}
              style={{ width: `${Math.max(1.2, (p.amount / cap) * 100)}%` }}
            />
          ))}
      </div>

      <div className="mt-2 flex justify-between gap-3 text-sm text-ink-soft">
        <span>
          {budget?.spentTodayLabel ?? usd(committed)} USDC committed (paid + held) in {paidCount} paid {paidCount === 1 ? "purchase" : "purchases"}
        </span>
        <span>{pctLabel}</span>
      </div>

      {budget && (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
          <div>
            <dt className="text-ink-soft">Budget day</dt>
            <dd className="font-medium">
              {budget.day} <span className="text-ink-soft">({budget.timeZone})</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">Spendable in Circle Gateway</dt>
            <dd className="font-medium">{budget.availableFundsLabel === null ? "Unavailable right now" : `${budget.availableFundsLabel} USDC`}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
